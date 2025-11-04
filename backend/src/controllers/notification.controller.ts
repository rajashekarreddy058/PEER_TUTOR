import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { Notification } from '../models/Notification';
import { sendNotificationToUser } from '../lib/socket';

export async function listNotifications(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { category, unreadOnly, limit = 50 } = req.query;
  
  let query: any = { userId };
  
  if (category) {
    query.category = category;
  }
  
  if (unreadOnly === 'true') {
    query.read = false;
  }
  
  const list = await Notification.find(query)
    .sort({ priority: -1, createdAt: -1 })
    .limit(parseInt(limit as string));
  // Post-process some legacy/older notifications: if a notification lacks a title/message
  // but has type 'session_booked', try to enrich it with student name using sessionId
  const enriched = await Promise.all((list || []).map(async (n: any) => {
    try {
      if ((!n.title || String(n.title).trim() === '') && n.type === 'session_booked' && n.data && n.data.sessionId) {
        const { Session } = await import('../models/Session');
        const sess = await Session.findById(n.data.sessionId).populate({ path: 'studentId', select: 'fullName' }).lean();
        let studentName = 'A student';
        if (sess && (sess as any).studentId && (sess as any).studentId.fullName) studentName = (sess as any).studentId.fullName;
        n.title = 'Session booked';
        n.message = `Session booked by ${studentName}`;
      }
    } catch (e) { /* ignore enrichment errors */ }
    return n;
  }));

  res.json(enriched);
}

export async function markRead(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { id } = req.params;
  const item = await Notification.findOneAndUpdate({ _id: id, userId }, { read: true }, { new: true });
  res.json(item);
}

export async function markReadBySession(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { sessionId } = req.params;
  if (!sessionId) return res.status(400).json({ message: 'sessionId required' });
  const q: any = { userId, 'data.sessionId': sessionId };
  await Notification.updateMany(q, { $set: { read: true } });
  const list = await Notification.find(q).sort({ createdAt: -1 }).limit(50);
  res.json(list);
}

export async function markAllRead(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const result = await Notification.updateMany({ userId, read: false }, { read: true });
  res.json({ message: 'All notifications marked as read', count: result.modifiedCount });
}

export async function getUnreadCount(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const count = await Notification.countDocuments({ userId, read: false });
  res.json({ unreadCount: count });
}

export async function deleteNotification(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { id } = req.params;
  const result = await Notification.findOneAndDelete({ _id: id, userId });
  if (!result) return res.status(404).json({ message: 'Notification not found' });
  res.json({ message: 'Notification deleted' });
}

export async function createNotification(req: AuthRequest, res: Response) {
  const { userId, type, title, message, data, priority = 'medium', category } = req.body;
  if (!userId || !type || !title || !message || !category) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  
  const notification = await Notification.create({
    userId,
    type,
    title,
    message,
    data: data || {},
    priority,
    category
  });
  
  // Send real-time notification to user
  try {
    sendNotificationToUser(userId, {
      id: notification._id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      priority: notification.priority,
      category: notification.category,
      data: notification.data,
      read: notification.read,
      createdAt: new Date()
    });
  } catch (e) {
    console.error('Failed to send real-time notification:', e);
  }
  
  res.status(201).json(notification);
}


