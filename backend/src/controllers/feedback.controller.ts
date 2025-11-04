import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { Feedback } from '../models/Feedback';
import { Session } from '../models/Session';
import { TutorProfile } from '../models/TutorProfile';

// Recompute average rating and count for a tutor and persist to TutorProfile
async function recomputeTutorRating(tutorId: any) {
  try {
    const ag = await Feedback.aggregate([
      { $match: { tutorId: typeof tutorId === 'string' ? new (require('mongoose')).Types.ObjectId(tutorId) : tutorId } },
      { $group: { _id: '$tutorId', avg: { $avg: '$rating' }, cnt: { $sum: 1 } } }
    ]);
    if (ag && ag.length) {
      const rec = ag[0];
      const result = await TutorProfile.findByIdAndUpdate(tutorId, { averageRating: rec.avg || 0, ratingCount: rec.cnt || 0 });
      console.log('Updated tutor rating:', { tutorId, averageRating: rec.avg, ratingCount: rec.cnt, result: !!result });
    } else {
      // no feedbacks -> reset
      const result = await TutorProfile.findByIdAndUpdate(tutorId, { averageRating: 0, ratingCount: 0 });
      console.log('Reset tutor rating (no feedbacks):', { tutorId, result: !!result });
    }
  } catch (e) {
    console.error('recomputeTutorRating failed', e);
  }
}

export async function leaveFeedback(req: AuthRequest, res: Response) {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ message: 'Not authenticated' });
  const { sessionId, tutorId, rating, comment } = req.body;
  if (!sessionId || !tutorId || !rating) return res.status(400).json({ message: 'Missing required fields' });

  console.log('Received feedback data:', { sessionId, tutorId, rating, comment, tutorIdType: typeof tutorId });

  // Ensure tutorId is a valid ObjectId string
  let validTutorId = tutorId;
  if (typeof tutorId === 'object' && tutorId._id) {
    validTutorId = tutorId._id;
  } else if (typeof tutorId === 'object' && tutorId.id) {
    validTutorId = tutorId.id;
  }
  
  // Convert to ObjectId if it's a string
  const mongoose = require('mongoose');
  const tutorObjectId = typeof validTutorId === 'string' ? new mongoose.Types.ObjectId(validTutorId) : validTutorId;
  
  console.log('Processed tutorId:', { validTutorId, tutorObjectId });

  // Ensure session exists and the current user is the student for that session
  const session = await Session.findById(sessionId);
  if (!session) return res.status(404).json({ message: 'Session not found' });

  // Do not allow leaving feedback for cancelled sessions
  try {
    const sStatus = (session as any).status;
    if (sStatus === 'cancelled' || sStatus === 'canceled') {
      return res.status(400).json({ message: 'Cannot leave feedback for a cancelled session' });
    }
  } catch (e) {}

  // session.studentId may be an ObjectId or populated object
  const studentId = session.studentId && (session.studentId as any)._id ? String((session.studentId as any)._id) : String(session.studentId);
  if (String(userId) !== String(studentId)) return res.status(403).json({ message: 'Only the student can leave feedback' });

  // Check if feedback already exists for this session
  const existingFeedback = await Feedback.findOne({ sessionId, userId });
  if (existingFeedback) {
    return res.status(409).json({ message: 'Feedback already exists for this session' });
  }

  // Allow feedback if session is completed or if it's been at least 5 minutes since session start
  try {
    const scheduled = new Date(session.scheduledAt).getTime();
    const dur = (session.durationMinutes ?? 0) * 60000;
    const end = scheduled + dur;
    const now = Date.now();
    
    // Allow feedback if session is completed, or if it's been at least 5 minutes since start
    const fiveMinutesAfterStart = scheduled + (5 * 60000);
    if (now < fiveMinutesAfterStart && session.status !== 'completed') {
      return res.status(400).json({ message: 'Please wait at least 5 minutes after session start to leave feedback' });
    }
  } catch (e) { /* ignore date parsing errors and allow */ }

  const fb = await Feedback.create({ sessionId, tutorId: tutorObjectId, rating, comment, userId });
  // Update tutor aggregates and wait so we can return authoritative tutor info
  try { 
    await recomputeTutorRating(tutorObjectId);
    console.log('Tutor rating recomputed for tutorId:', tutorObjectId);
  } catch (e) { 
    console.error('recompute error', e); 
  }

  // Fetch authoritative session and include hasFeedback flag so client can rely on server state
  let sessionDoc: any = null;
  try {
    sessionDoc = await Session.findById(sessionId).lean();
    if (sessionDoc) {
      sessionDoc.hasFeedback = true;
    }
  } catch (e) { /* ignore */ }

  // Fetch updated tutor profile (aggregates) if available
  let tutorProfile: any = null;
  try {
    tutorProfile = await TutorProfile.findById(tutorObjectId).lean();
  } catch (e) { /* ignore */ }

  res.status(201).json({ feedback: fb, session: sessionDoc, tutor: tutorProfile });
}

export async function getFeedbackForTutor(_req: AuthRequest, res: Response) {
  const { tutorId } = _req.params as any;
  const list = await Feedback.find({ tutorId }).sort({ createdAt: -1 });
  res.json(list);
}


