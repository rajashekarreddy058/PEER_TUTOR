import { Request, Response, Router } from 'express';
import { Slot } from '../models/Slot';
import { TutorProfile } from '../models/TutorProfile';
import { Session } from '../models/Session';
import mongoose from 'mongoose';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import { User } from '../models/User';

const router = Router();

// Tutor defines availability range and slot duration -> generate slots avoiding overlaps
router.post('/create', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.userId!;
    const user = await User.findById(uid);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!user.isTutor) return res.status(403).json({ message: 'Only tutors can create slots' });
    const { date, startTime, endTime, slotDurationMinutes, scheduledStartIso, scheduledEndIso } = req.body;
    // Debug payload for easier diagnosis
    console.log('[slots:create] payload:', { date, startTime, endTime, slotDurationMinutes, scheduledStartIso, scheduledEndIso });

    // Accept either legacy (date + startTime + endTime) or ISO instants (scheduledStartIso, scheduledEndIso)
    let startAt: Date | null = null;
    let endAt: Date | null = null;
    if (scheduledStartIso && scheduledEndIso) {
      startAt = new Date(scheduledStartIso);
      endAt = new Date(scheduledEndIso);
      if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) return res.status(400).json({ message: 'Invalid ISO datetimes' });
    } else {
      if (!date || !startTime || !endTime || !slotDurationMinutes) return res.status(400).json({ message: 'Missing params' });
      // date: YYYY-MM-DD, startTime/endTime: HH:mm (24h)
      const [sh, sm] = (startTime || '').split(':').map((x: any) => Number(x));
      const [eh, em] = (endTime || '').split(':').map((x: any) => Number(x));
      if (Number.isNaN(sh) || Number.isNaN(sm) || Number.isNaN(eh) || Number.isNaN(em)) return res.status(400).json({ message: 'Invalid time format' });
      // Construct Date objects in local time using date components to avoid timezone math issues
      const [y, m, d] = (date || '').split('-').map((x: any) => Number(x));
      if ([y, m, d].some(v => Number.isNaN(v))) return res.status(400).json({ message: 'Invalid date format' });
      startAt = new Date(y, m - 1, d, sh, sm, 0, 0);
      endAt = new Date(y, m - 1, d, eh, em, 0, 0);
    }
    if (!startAt || !endAt) return res.status(400).json({ message: 'Invalid start/end times' });
    if (endAt <= startAt) return res.status(400).json({ message: 'endTime must be after startTime' });

    // Prevent creating slots that start in the past (small 60s grace to account for clock skew)
    if (startAt.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ message: 'Cannot create slots in the past' });

    const tutorProfile = await TutorProfile.findOne({ userId: user._id });
    if (!tutorProfile) return res.status(404).json({ message: 'Tutor profile not found' });

    const duration = Number(slotDurationMinutes);
    if (!duration || duration < 10) return res.status(400).json({ message: 'Invalid slot duration' });

    // Build slot times sequentially
    const slotsToCreate: any[] = [];
    let cur = new Date(startAt);
    while (cur.getTime() + duration * 60000 <= endAt.getTime()) {
      const s = new Date(cur);
      const e = new Date(cur.getTime() + duration * 60000);
      // Check overlaps: make sure no existing slot for this tutor overlaps [s,e)
      const overlap = await Slot.findOne({ tutorId: tutorProfile._id, $or: [
        { startAt: { $lt: e }, endAt: { $gt: s } }
      ] });
      if (!overlap) {
        slotsToCreate.push({ tutorId: tutorProfile._id, startAt: s, endAt: e, durationMinutes: duration });
      }
      cur = new Date(cur.getTime() + duration * 60000);
    }

    if (slotsToCreate.length === 0) return res.status(200).json({ created: 0, message: 'No new slots (all would overlap existing slots)' });
    const created = await Slot.insertMany(slotsToCreate);
    return res.json({ created: created.length, slots: created });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// List slots for a tutor (public) - upcoming only by default
router.get('/tutor/:tutorId', async (req: Request, res: Response) => {
  try {
    const { tutorId } = req.params;
    const now = new Date();
    console.log('[slots:tutor] fetching slots for tutorId:', tutorId, 'now:', now.toISOString());
    const slots = await Slot.find({ tutorId, startAt: { $gte: now }, status: 'available' }).sort({ startAt: 1 }).limit(200);
    console.log('[slots:tutor] found', slots.length, 'available slots');
    // Also log all slots for this tutor regardless of status for debugging
    const allSlots = await Slot.find({ tutorId }).sort({ startAt: 1 }).limit(500);
    console.log('[slots:tutor] total slots for this tutor (all statuses):', allSlots.length);
    allSlots.slice(0, 3).forEach((s: any) => console.log('[slots:tutor] sample slot:', { startAt: s.startAt, status: s.status }));
    return res.json(slots);
  } catch (err) {
    console.error('[slots:tutor] error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Tutor lists all their slots (including booked/disabled)
router.get('/mine', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.userId!;
    const user = await User.findById(uid);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!user.isTutor) return res.status(403).json({ message: 'Only tutors' });
    const tutor = await TutorProfile.findOne({ userId: user._id });
    if (!tutor) return res.status(404).json({ message: 'Tutor profile not found' });
    const slots = await Slot.find({ tutorId: tutor._id }).sort({ startAt: 1 }).limit(1000);
    return res.json(slots);
  } catch (err) { console.error(err); return res.status(500).json({ message: 'Server error' }); }
});

// Tutor disable a slot
router.post('/:slotId/disable', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.userId!;
    const user = await User.findById(uid);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!user.isTutor) return res.status(403).json({ message: 'Only tutors' });
    const { slotId } = req.params;
    const tutor = await TutorProfile.findOne({ userId: user._id });
    if (!tutor) return res.status(404).json({ message: 'Tutor profile not found' });
    const slot = await Slot.findById(slotId);
    if (!slot) return res.status(404).json({ message: 'Slot not found' });
    if (String(slot.tutorId) !== String(tutor._id)) return res.status(403).json({ message: 'Not your slot' });
    slot.status = 'disabled';
    await slot.save();
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ message: 'Server error' }); }
});

// Student books a slot -> create a Session and mark slot as booked
router.post('/:slotId/book', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.userId!;
    console.log('[slots:book] Starting booking for user:', uid, 'slot:', req.params.slotId);
    
    const user = await User.findById(uid);
    if (!user) { 
      return res.status(401).json({ message: 'Unauthorized' }); 
    }
    
    const { slotId } = req.params;
    const slot = await Slot.findById(slotId);
    if (!slot) { 
      return res.status(404).json({ message: 'Slot not found' }); 
    }
    
    if (slot.status !== 'available') { 
      return res.status(409).json({ message: 'Slot not available' }); 
    }
    
    console.log('[slots:book] Slot found and available, user._id type:', typeof user._id, 'value:', user._id);
    
    // mark slot booked - use proper ObjectId assignment
    slot.status = 'booked';
    slot.bookedBy = new mongoose.Types.ObjectId(user._id as string);
    await slot.save();
    console.log('[slots:book] Slot marked as booked');
    
    // create Session record
    const tutorProfile = await TutorProfile.findById(slot.tutorId);
    if (!tutorProfile) { 
      return res.status(404).json({ message: 'Tutor not found' }); 
    }
    
    const newSession = await Session.create({ 
      tutorId: tutorProfile._id, 
      studentId: new mongoose.Types.ObjectId(user._id as string), 
      subject: req.body.subject || 'Tutoring', 
      scheduledAt: slot.startAt, 
      durationMinutes: slot.durationMinutes, 
      status: 'scheduled', 
      notes: req.body.notes || undefined 
    });
    console.log('[slots:book] Session created:', newSession._id);
    
    // link session id to slot
    slot.sessionId = newSession._id;
    await slot.save();
    console.log('[slots:book] Slot updated with sessionId');
    
    // create a non-blocking notification for the tutor so frontend polling picks up the booking
    try {
      const tutorUserId = tutorProfile.userId;
      try {
        await (await import('../models/Notification')).Notification.create({ userId: tutorUserId as any, type: 'session_booked', data: { sessionId: newSession._id, subject: req.body.subject || 'Tutoring', scheduledAt: slot.startAt, durationMinutes: slot.durationMinutes } });
      } catch (e) { /* ignore notification failures */ }
    } catch (e) { /* ignore dynamic import failures */ }

    // emit socket event to tutor (and student) so real-time clients update immediately
    try {
      const { getIo } = await import('../lib/socket');
      const io = getIo();
      if (io) {
        const sessObj: any = (typeof newSession.toObject === 'function') ? newSession.toObject() : Object.assign({}, newSession);
        // join user rooms by userId; tutorProfile.userId references the user
        if (tutorProfile && tutorProfile.userId) {
          io.to(`user:${String(tutorProfile.userId)}`).emit('session_created', sessObj);
        }
        if (user && user._id) {
          io.to(`user:${String(user._id)}`).emit('session_created', sessObj);
        }
      }
    } catch (e) { console.error('failed to emit session_created', e); }

    // Normalize session object for API clients: ensure _id exists and scheduledAt is an ISO string
    try {
      const sessObj: any = (typeof newSession.toObject === 'function') ? newSession.toObject() : Object.assign({}, newSession);
      if (sessObj && sessObj.scheduledAt) {
        try { sessObj.scheduledAt = new Date(sessObj.scheduledAt).toISOString(); } catch (e) { /* ignore */ }
      }
      if (!sessObj._id && sessObj.id) sessObj._id = sessObj.id;
      return res.json({ ok: true, session: sessObj, slot });
    } catch (e) {
      return res.json({ ok: true, session: newSession, slot });
    }
  } catch (err) {
    console.error('[slots:book] Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// student lists their booked slots/sessions
router.get('/my-bookings', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.userId!;
    const user = await User.findById(uid);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    // find slots booked by user, populate session
    const slots = await Slot.find({ bookedBy: user._id }).sort({ startAt: 1 }).limit(200).populate('sessionId');
    return res.json(slots);
  } catch (err) { console.error(err); return res.status(500).json({ message: 'Server error' }); }
});

// Delete a slot (tutor only) - only if not booked
router.delete('/:slotId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.userId!;
    const user = await User.findById(uid);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!user.isTutor) return res.status(403).json({ message: 'Only tutors' });
    const tutor = await TutorProfile.findOne({ userId: user._id });
    if (!tutor) return res.status(404).json({ message: 'Tutor profile not found' });
    const slot = await Slot.findById(req.params.slotId);
    if (!slot) return res.status(404).json({ message: 'Slot not found' });
    if (String(slot.tutorId) !== String(tutor._id)) return res.status(403).json({ message: 'Not your slot' });
    if (slot.status === 'booked') return res.status(400).json({ message: 'Cannot delete booked slot' });
  await slot.deleteOne();
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ message: 'Server error' }); }
});

export { router };
