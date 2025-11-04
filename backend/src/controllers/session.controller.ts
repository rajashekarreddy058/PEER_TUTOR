import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { Session } from '../models/Session';
import { Slot } from '../models/Slot';
import { TutorProfile } from '../models/TutorProfile';
import { Notification } from '../models/Notification';
import { sendNotificationToUser } from '../lib/socket';
import { User } from '../models/User';
import { Feedback } from '../models/Feedback';
import jwt from 'jsonwebtoken';
import { IssuedToken } from '../models/IssuedToken';
import { JoinLog } from '../models/JoinLog';

export async function listSessions(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const role = req.query.role as 'tutor' | 'student' | undefined;
  const status = req.query.status as 'scheduled' | 'completed' | 'cancelled' | undefined;
  const filter: any = {};
  if (role === 'tutor') {
    // The tutorId stored on Session references the TutorProfile _id. If the caller
    // asked for role=tutor but provided an authenticated userId, resolve the
    // TutorProfile owned by this user and use its _id for filtering so tutors
    // see sessions where they are the tutor.
    try {
      const myProfile = await TutorProfile.findOne({ userId: userId });
      if (myProfile) filter.tutorId = myProfile._id;
      else filter.tutorId = userId; // fallback in case sessions stored raw userId
    } catch (e) {
      filter.tutorId = userId;
    }
  } else {
    filter.studentId = userId;
  }
  if (status) filter.status = status;
  const sessions = await Session.find(filter)
    .sort({ scheduledAt: -1 })
    .populate({ path: 'studentId', select: 'fullName' })
    .populate({ path: 'tutorId', populate: { path: 'userId', select: 'fullName' }, select: 'name userId' })
    .lean();
  // attach top-level studentName and tutorName for ease of consumption by the frontend
  const sessionIds = sessions.map((s: any) => String(s._id));
  // find feedbacks by this user for these sessions
  const feedbacks = await Feedback.find({ sessionId: { $in: sessionIds }, userId }).select('sessionId').lean();
  const feedbackSet = new Set(feedbacks.map((f: any) => String(f.sessionId)));
  const out = sessions.map((s: any) => {
    const studentName = (s.studentId && s.studentId.fullName) ? s.studentId.fullName : (s.studentName || null);
    let tutorName = null;
    try {
      tutorName = s.tutor?.user?.fullName || s.tutor?.name || s.tutorName || null;
    } catch (e) { tutorName = s.tutorName || null; }
    const hasFeedback = feedbackSet.has(String(s._id));
    return { ...s, studentName, tutorName, hasFeedback };
  });
  res.json(out);
}

export async function bookSession(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { tutorId, subject, scheduledAt, durationMinutes, notes } = req.body as { tutorId: string; subject: string; scheduledAt: string; durationMinutes: number; notes?: string };
  if (!tutorId || !subject || !scheduledAt || !durationMinutes) return res.status(400).json({ message: 'Missing required fields' });

  const tutor = await TutorProfile.findById(tutorId);
  if (!tutor) return res.status(404).json({ message: 'Tutor not found' });
  // Prevent a tutor from booking a session with themselves
  try {
    let tutorUserId: any = null;
    if (tutor.userId) {
      tutorUserId = (tutor.userId as any)._id || tutor.userId;
    }
    if (tutorUserId && String(tutorUserId) === String(userId)) return res.status(403).json({ message: 'Tutors cannot book sessions with themselves' });
  } catch (e) { /* ignore */ }

  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);

  // Check for conflicts: overlapping sessions for tutor or student
  const conflict = await Session.findOne({
    status: { $ne: 'cancelled' },
    $or: [
      { tutorId: tutor._id },
      { studentId: userId },
    ],
    $expr: {
      $and: [
        { $lt: ['$scheduledAt', end] },
        { $gt: [{ $add: ['$scheduledAt', { $multiply: ['$durationMinutes', 60000] }] }, start] },
      ],
    },
  });
  if (conflict) return res.status(409).json({ message: 'Time slot not available' });

  const session = await Session.create({ tutorId, studentId: userId, subject, scheduledAt: start, durationMinutes, notes });
  // Notify tutor (persist + real-time emit if connected)
  try {
    // include student's name in the notification message
    let studentName = 'A student';
    try {
      const student = await User.findById(userId).select('fullName').lean();
      if (student && (student as any).fullName) studentName = (student as any).fullName;
    } catch (e) {}
    const note = await Notification.create({ userId: String(tutor.userId), type: 'session_booked', title: 'Session booked', message: `Session booked by ${studentName}`, data: { sessionId: session._id, subject, scheduledAt: start, durationMinutes } });
    try { sendNotificationToUser(String(tutor.userId), { id: note._id, type: note.type, title: note.title || 'Session booked', message: note.message || `Session booked by ${studentName}`, data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {}
  } catch (e) { console.error('failed to create/emit tutor notification', e); }
  // Notify student (persist + real-time emit if connected) with tutor name
  try {
    let tutorName = 'Tutor';
    try {
      if (tutor.userId) {
        const tutUser = await User.findById(String(tutor.userId)).select('fullName').lean();
        if (tutUser && (tutUser as any).fullName) tutorName = (tutUser as any).fullName;
      }
    } catch (e) {}
    const studentNote = await Notification.create({ userId: String(userId), type: 'session_booked', title: 'Session booked', message: `Session booked with ${tutorName}`, data: { sessionId: session._id, subject, scheduledAt: start, durationMinutes } });
    try { sendNotificationToUser(String(userId), { id: studentNote._id, type: studentNote.type, title: studentNote.title || 'Session booked', message: studentNote.message || `Session booked with ${tutorName}`, data: studentNote.data, read: studentNote.read, createdAt: (studentNote as any).createdAt }); } catch (e) {}
  } catch (e) { console.error('failed to create/emit student notification', e); }
  res.status(201).json(session);
}

// Student requests a meeting with a tutor (non-committal) -> create a notification
export async function requestMeeting(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { tutorId, subject, message } = req.body as { tutorId: string; subject?: string; message?: string };
  if (!tutorId) return res.status(400).json({ message: 'Missing tutorId' });
  try {
    const tutor = await TutorProfile.findById(tutorId);
    if (!tutor) return res.status(404).json({ message: 'Tutor not found' });
    // create notification for tutor to respond
    try {
      const note = await Notification.create({ userId: String(tutor.userId), type: 'meeting_request', data: { from: userId, subject: subject || 'Meeting request', message: message || '' } });
  try { sendNotificationToUser(String(tutor.userId), { id: note._id, type: note.type, title: note.title || 'Meeting request', message: note.message || message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {}
    } catch (e) { /* ignore */ }
    return res.json({ ok: true });
  } catch (e) {
    console.error('requestMeeting failed', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// Tutor can instantly start a meeting for a session or create an on-the-fly in-progress session
export async function instantStart(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { id } = req.params; // optional session id
  try {
    // If id is provided, try to load and ensure the caller is the tutor
    let session = null as any;
    if (id) session = await Session.findById(id);
    // If session exists, check tutor ownership
    if (session) {
      const tutorProfile = await TutorProfile.findById(session.tutorId);
      const tutorUserId = tutorProfile ? String(tutorProfile.userId) : String(session.tutorId);
      if (String(userId) !== String(tutorUserId)) return res.status(403).json({ message: 'Not authorized' });
    }

    // Create meeting URL/token for either existing session or a lightweight ad-hoc session
    const secret = process.env.JWT_SECRET || 'change_me';
    const shortToken = Math.random().toString(36).slice(2, 8);
    const meetRoom = `session-${session?._id || shortToken}-${Date.now().toString(36)}`;
    const meetingUrl = `https://meet.jit.si/${meetRoom}`;
    const joinToken = jwt.sign({ sessionId: session?._id || null, startedBy: userId }, secret, { expiresIn: '6h' });
    const expiresAt = new Date(Date.now() + 6 * 60 * 60000);

    if (session) {
      session.meetingUrl = meetingUrl;
      session.joinToken = joinToken;
      session.meetingUrlExpiresAt = expiresAt;
      session.status = 'in-progress' as any;
      await session.save();
    } else {
      // create a lightweight session record (student unspecified) and mark in-progress
      session = await Session.create({ tutorId: userId, studentId: null, subject: 'Instant meeting', scheduledAt: new Date(), durationMinutes: 60, status: 'in-progress', meetingUrl, joinToken, meetingUrlExpiresAt: expiresAt });
    }

    // notify connected students or the tutor's students (best-effort)
    try {
      if (session.studentId) {
        const note = await Notification.create({ userId: String(session.studentId), type: 'session_started', data: { sessionId: session._id, meetingUrl, joinToken, expiresAt } });
        try { sendNotificationToUser(String(session.studentId), { id: note._id, type: note.type, title: note.title || 'Session started', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {}
      }
      const tutorProfileTmp = await TutorProfile.findById(session.tutorId);
      const tutorUserTmp = tutorProfileTmp ? tutorProfileTmp.userId : session.tutorId;
      if (tutorUserTmp) {
        const note = await Notification.create({ userId: String(tutorUserTmp), type: 'session_started', data: { sessionId: session._id, meetingUrl, joinToken, expiresAt } });
        try { sendNotificationToUser(String(tutorUserTmp), { id: note._id, type: note.type, title: note.title || 'Session started', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {}
      }
    } catch (e) { /* ignore */ }

    // emit socket event to involved users
    try {
      const { getIo } = await import('../lib/socket');
      const io = getIo();
      if (io) {
        const payload = { sessionId: session._id, meetingUrl, joinToken, expiresAt };
        try { if (session.studentId) io.to(`user:${String(session.studentId)}`).emit('session_started', payload); } catch (e) {}
        try { io.to(`user:${String(session.tutorId)}`).emit('session_started', payload); } catch (e) {}
      }
    } catch (e) { console.error('failed to emit session_started (instant)', e); }

    return res.json({ meetingUrl, joinToken, expiresAt, session });
  } catch (e) {
    console.error('instantStart failed', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

export async function completeSession(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const userId = req.userId!;
  const session = await Session.findById(id);
  if (!session) return res.status(404).json({ message: 'Session not found' });
  // allow only the tutor or the student to mark complete
  let allowed = false;
  try {
    const tutorProfile = await TutorProfile.findById(session.tutorId);
    const tutorUserId = tutorProfile ? String(tutorProfile.userId) : String(session.tutorId);
    if (String(userId) === String(tutorUserId)) allowed = true;
  } catch (e) {}
  if (String(userId) === String(session.studentId)) allowed = true;
  if (!allowed) return res.status(403).json({ message: 'Not authorized to complete this session' });

  session.status = 'completed' as any;
  await session.save();
  try { if (session.studentId) { const note = await Notification.create({ userId: String(session.studentId), type: 'session_completed', data: { sessionId: session._id } }); try { sendNotificationToUser(String(session.studentId), { id: note._id, type: note.type, title: note.title || 'Session completed', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {} } } catch (e) {}
  res.json(session);
}

export async function cancelSession(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const session = await Session.findByIdAndUpdate(id, { status: 'cancelled' }, { new: true });
  if (session) {
    try { const note = await Notification.create({ userId: String(session.tutorId), type: 'session_cancelled', data: { sessionId: session._id } }); try { sendNotificationToUser(String(session.tutorId), { id: note._id, type: note.type, title: note.title || 'Session cancelled', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {} } catch (e) {}
    // If this session was created from a slot, free that slot for others
    try {
      await Slot.findOneAndUpdate({ sessionId: session._id }, { status: 'available', bookedBy: null, sessionId: null });
    } catch (e) { console.error('failed to free slot on cancel', e); }
  }
  res.json(session);
}

export async function sessionsByTutor(req: AuthRequest, res: Response) {
  const { tutorId } = req.params;
  const list = await Session.find({ tutorId })
    .sort({ scheduledAt: -1 })
    .populate({ path: 'studentId', select: 'fullName' })
    .populate({ path: 'tutorId', populate: { path: 'userId', select: 'fullName' }, select: 'name userId' })
    .lean();
  // annotate hasFeedback for the requesting user if present
  const userId = req.userId || null;
  const sessionIds = list.map((s: any) => String(s._id));
  const feedbacks = userId ? await Feedback.find({ sessionId: { $in: sessionIds }, userId }).select('sessionId').lean() : [];
  const feedbackSet = new Set(feedbacks.map((f: any) => String(f.sessionId)));
  const out = list.map((s: any) => ({
    ...s,
    studentName: (s.studentId && s.studentId.fullName) ? s.studentId.fullName : (s.studentName || null),
    tutorName: s.tutor?.user?.fullName || s.tutor?.name || s.tutorName || null,
    hasFeedback: userId ? feedbackSet.has(String(s._id)) : false
  }));
  res.json(out);
}

export async function sessionsByStudent(req: AuthRequest, res: Response) {
  const { studentId } = req.params;
  const list = await Session.find({ studentId })
    .sort({ scheduledAt: -1 })
    .populate({ path: 'studentId', select: 'fullName' })
    .populate({ path: 'tutorId', populate: { path: 'userId', select: 'fullName' }, select: 'name userId' })
    .lean();
  const userId = req.userId || null;
  const sessionIds = list.map((s: any) => String(s._id));
  const feedbacks = userId ? await Feedback.find({ sessionId: { $in: sessionIds }, userId }).select('sessionId').lean() : [];
  const feedbackSet = new Set(feedbacks.map((f: any) => String(f.sessionId)));
  const out = list.map((s: any) => ({
    ...s,
    studentName: (s.studentId && s.studentId.fullName) ? s.studentId.fullName : (s.studentName || null),
    tutorName: s.tutor?.user?.fullName || s.tutor?.name || s.tutorName || null,
    hasFeedback: userId ? feedbackSet.has(String(s._id)) : false
  }));
  res.json(out);
}

export async function startSession(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { id } = req.params;
  const session = await Session.findById(id);
  if (!session) return res.status(404).json({ message: 'Session not found' });

  // Only the tutor (the user who owns the TutorProfile referenced by tutorId) can start
  const tutorProfile = await TutorProfile.findById(session.tutorId);
  if (!tutorProfile) return res.status(404).json({ message: 'Tutor profile not found' });
  if (String(tutorProfile.userId) !== String(userId)) return res.status(403).json({ message: 'Only the tutor can start the session' });

  // Only allow starting within a reasonable window (e.g., 15 minutes before scheduledAt)
  const now = new Date();
  const startWindow = new Date(session.scheduledAt.getTime() - 15 * 60000);
  const endWindow = new Date(session.scheduledAt.getTime() + 4 * 60 * 60000); // allow start up to 4 hours after
  // Allow a forced start for local testing either by setting ALLOW_EARLY_START=true
  // in the environment or by passing ?force=1 on the request. Only tutors can start,
  // so this is a dev convenience to unblock MVP testing.
  const allowEarly = (process.env.ALLOW_EARLY_START === 'true') || (req.query && String(req.query.force) === '1');
  if (now < startWindow && !allowEarly) return res.status(400).json({ message: 'Too early to start the session' });
  if (now > endWindow) return res.status(400).json({ message: 'Session start window has passed' });

  // If already started, return existing meetingUrl
  if (session.status === 'in-progress' || session.meetingUrl) {
    return res.json({ meetingUrl: session.meetingUrl });
  }

  // generate a reasonably unique room name
  const shortToken = Math.random().toString(36).slice(2, 8);
  const room = `session-${session._id}-${shortToken}`;
  const meetingUrl = `https://meet.jit.si/${room}`;

  // generate a signed join token (JWT) with expiry to limit link lifetime
  const secret = process.env.JWT_SECRET || 'change_me';
  const joinToken = jwt.sign({ sessionId: session._id, startedBy: userId }, secret, { expiresIn: '6h' });
  const expiresAt = new Date(Date.now() + 6 * 60 * 60000); // 6 hours

  session.meetingUrl = meetingUrl;
  session.joinToken = joinToken;
  session.meetingUrlExpiresAt = expiresAt;
  session.status = 'in-progress' as any;
  await session.save();

  console.log(`Session ${session._id} started by user ${userId}. meetingUrl=${meetingUrl} token=${joinToken} expires=${expiresAt.toISOString()}`);

  // notify the student and tutor (best-effort)
  try {
    if (session.studentId) {
      const note = await Notification.create({ userId: String(session.studentId), type: 'session_started', data: { sessionId: session._id, meetingUrl, joinToken, expiresAt } });
      try { sendNotificationToUser(String(session.studentId), { id: note._id, type: note.type, title: note.title || 'Session started', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {}
    }
    // also notify the tutor (their userId is stored on TutorProfile)
    try {
      const tutorProfile = await TutorProfile.findById(session.tutorId);
      const tutorUser = tutorProfile ? tutorProfile.userId : session.tutorId;
      if (tutorUser) {
        const note = await Notification.create({ userId: String(tutorUser), type: 'session_started', data: { sessionId: session._id, meetingUrl, joinToken, expiresAt } });
        try { sendNotificationToUser(String(tutorUser), { id: note._id, type: note.type, title: note.title || 'Session started', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {}
      }
    } catch (e) {
      console.error('failed to create tutor notification', e);
    }
  } catch (e) {
    // non-fatal
    console.error('failed to create notification', e);
  }

  // emit socket event to student and tutor
  try {
    const { getIo } = await import('../lib/socket');
    const io = getIo();
    if (io) {
      const payload = { sessionId: session._id, meetingUrl, joinToken, expiresAt };
      try { io.to(`user:${String(session.studentId)}`).emit('session_started', payload); } catch (e) {}
      try {
        const tutorProfile = await TutorProfile.findById(session.tutorId);
        const tutorUser = tutorProfile ? tutorProfile.userId : session.tutorId;
        if (tutorUser) io.to(`user:${String(tutorUser)}`).emit('session_started', payload);
      } catch (e) {}
    }
  } catch (e) { console.error('failed to emit session_started', e); }

  res.json({ meetingUrl, joinToken, expiresAt });
}

export async function joinSession(req: any, res: Response) {
  const { id } = req.params;
  const { token } = req.query as { token?: string };
  const secret = process.env.JWT_SECRET || 'change_me';
  let authUserId: string | null = null;
  // If Authorization header is present, try to verify it to get userId (allows tutors to join)
  try {
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (bearer) {
      const payload: any = jwt.verify(bearer, secret);
      authUserId = payload?.userId || null;
    }
  } catch (e) {
    // ignore auth verification errors here; we'll still accept valid join token below
    authUserId = null;
  }

  // If we have a join token, validate it. Prefer issued short-lived tokens (single-use) stored in IssuedToken.
  let tokenDecoded: any = null;
  let usedIssuedToken: any = null;
  if (token) {
    try {
      // check issued tokens collection first
      const it = await IssuedToken.findOne({ token });
      if (it) {
        // ensure not used and not expired
        if (it.used) return res.status(403).json({ message: 'Token already used' });
        if (it.expiresAt && new Date() > it.expiresAt) return res.status(403).json({ message: 'Token expired' });
        tokenDecoded = jwt.verify(String(token), secret);
        usedIssuedToken = it;
      } else {
        // fallback: verify token (could be the session.joinToken created by startSession)
        tokenDecoded = jwt.verify(String(token), secret);
      }
    } catch (e) {
      tokenDecoded = null;
    }
  }

  // Require either a valid join token for this session or an authenticated tutor
  const session = await Session.findById(id);
  if (!session || !session.meetingUrl) return res.status(404).json({ message: 'Session or meeting URL not found' });

  let allowed = false;
  if (tokenDecoded && String(tokenDecoded.sessionId) === String(id)) allowed = true;
  if (!allowed && authUserId) {
    // check if authUserId is the tutor for this session
    try {
      const tutorProfile = await TutorProfile.findById(session.tutorId);
      const tutorUserId = tutorProfile ? String(tutorProfile.userId) : String(session.tutorId);
      if (String(authUserId) === String(tutorUserId)) allowed = true;
    } catch (e) { /* ignore */ }
    // also allow the authenticated student themselves to join without the join token
    try {
      if (String(authUserId) === String(session.studentId)) allowed = true;
    } catch (e) { /* ignore */ }
  }

  if (!allowed) return res.status(403).json({ message: 'Invalid token or unauthorized' });

  // record join log
  try {
    const ip = req.headers['x-forwarded-for'] || req.ip;
    const ua = req.headers['user-agent'] || '';
    const userIdForLog = tokenDecoded?.userId || authUserId || null;
    const tokenSnippet = token ? String(token).slice(0, 8) : (authUserId ? 'auth' : '');
    await JoinLog.create({ sessionId: session._id, userId: userIdForLog, tokenSnippet, ip: String(ip), userAgent: ua });
    // mark issued token as used (single-use)
    try {
      if (usedIssuedToken) {
        usedIssuedToken.used = true;
        await usedIssuedToken.save();
      }
    } catch (e) { console.error('failed to mark issued token used', e); }
  } catch (e) {
    console.error('failed to write join log', e);
  }

  return res.redirect(session.meetingUrl);
}

export async function issueJoinToken(req: AuthRequest, res: Response) {
  const userId = req.userId;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ message: 'Not authenticated' });
  const session = await Session.findById(id);
  if (!session || !session.meetingUrl) return res.status(404).json({ message: 'Session not found or not started' });
  // allow only the student or the tutor to request a token
  let allowed = false;
  try {
    if (String(userId) === String(session.studentId)) allowed = true;
    const tutorProfile = await TutorProfile.findById(session.tutorId);
    const tutorUserId = tutorProfile ? String(tutorProfile.userId) : String(session.tutorId);
    if (String(userId) === String(tutorUserId)) allowed = true;
  } catch (e) { /* ignore */ }
  if (!allowed) return res.status(403).json({ message: 'Not authorized to issue join token' });

  const secret = process.env.JWT_SECRET || 'change_me';
  // short lived token for this user/session
  const shortToken = jwt.sign({ sessionId: session._id, userId }, secret, { expiresIn: '15m' });
  const expiresAt = new Date(Date.now() + 15 * 60000);
  try {
    await IssuedToken.create({ sessionId: session._id, userId, token: shortToken, expiresAt });
  } catch (e) { console.error('failed to persist issued token', e); }
  res.json({ joinToken: shortToken, expiresAt });
}

export async function updateSession(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { id } = req.params;
  const { subject, scheduledAt, durationMinutes, notes } = req.body as { subject?: string; scheduledAt?: string; durationMinutes?: number; notes?: string };
  const session = await Session.findById(id);
  if (!session) return res.status(404).json({ message: 'Session not found' });
  // Only the student who booked can update (and only if not started/completed/cancelled)
  if (String(session.studentId) !== String(userId)) return res.status(403).json({ message: 'Not authorized to update this session' });
  if (session.status !== 'scheduled') return res.status(400).json({ message: 'Only scheduled sessions can be updated' });

  // If changing time, ensure no conflict
  let start = session.scheduledAt;
  if (scheduledAt) start = new Date(scheduledAt);
  const duration = durationMinutes ?? session.durationMinutes ?? 60;
  const end = new Date(start.getTime() + duration * 60000);

  const conflict = await Session.findOne({
    _id: { $ne: session._id },
    status: { $ne: 'cancelled' },
    $or: [ { tutorId: session.tutorId }, { studentId: userId } ],
    $expr: {
      $and: [
        { $lt: ['$scheduledAt', end] },
        { $gt: [{ $add: ['$scheduledAt', { $multiply: ['$durationMinutes', 60000] }] }, start] }
      ]
    }
  });
  if (conflict) return res.status(409).json({ message: 'Time slot not available' });

  if (subject) session.subject = subject;
  session.scheduledAt = start;
  session.durationMinutes = duration;
  if (notes !== undefined) session.notes = notes;
  await session.save();
  // notify tutor of update
  try { const note = await Notification.create({ userId: String(session.tutorId), type: 'session_updated', data: { sessionId: session._id } }); try { sendNotificationToUser(String(session.tutorId), { id: note._id, type: note.type, title: note.title || 'Session updated', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {} } catch (e) {}
  res.json(session);
}

export async function deleteSession(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  const { id } = req.params;
  const session = await Session.findById(id);
  if (!session) return res.status(404).json({ message: 'Session not found' });
  // Only the booking student can delete/ cancel before it starts
  if (String(session.studentId) !== String(userId)) return res.status(403).json({ message: 'Not authorized to delete this session' });
  if (session.status !== 'scheduled') return res.status(400).json({ message: 'Only scheduled sessions can be deleted' });

  session.status = 'cancelled' as any;
  await session.save();
  try { const note = await Notification.create({ userId: String(session.tutorId), type: 'session_cancelled', data: { sessionId: session._id } }); try { sendNotificationToUser(String(session.tutorId), { id: note._id, type: note.type, title: note.title || 'Session cancelled', message: note.message || '', data: note.data, read: note.read, createdAt: (note as any).createdAt }); } catch (e) {} } catch (e) {}
  // If the session was linked to a slot, free the slot so others can book it
  try {
    await Slot.findOneAndUpdate({ sessionId: session._id }, { status: 'available', bookedBy: null, sessionId: null });
  } catch (e) { console.error('failed to free slot on delete', e); }
  res.json({ success: true, session });
}


