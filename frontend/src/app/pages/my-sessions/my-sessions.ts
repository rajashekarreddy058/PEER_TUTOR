import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { JitsiModal } from '../../components/jitsi-modal/jitsi-modal';
import { environment } from '../../../environments/environment';
import { SessionsService } from '../../services/sessions.service';
import { Router } from '@angular/router';
import { ToastService } from '../../services/toast.service';
import { NotificationService } from '../../services/notification.service';
import { FeedbackService } from '../../services/feedback.service';
import { SlotsService } from '../../services/slots.service';

@Component({
  selector: 'app-my-sessions',
  imports: [CommonModule, FormsModule, JitsiModal],
  templateUrl: './my-sessions.html',
  styleUrls: ['./my-sessions.css']
})
export class MySessions implements OnInit, OnDestroy {
  private sessionsService = inject(SessionsService);
  private notificationsSvc = inject(NotificationService);
  private toast = inject(ToastService);
  private feedbackSvc = inject(FeedbackService);
  private slotsService = inject(SlotsService);
  private router = inject(Router);
  sessions: any[] = [];
  filter: 'all' | 'upcoming' | 'past' = 'upcoming';
  // view mode: 'student' or 'tutor'
  sessionsView: 'student' | 'tutor' = 'student';
  // how many minutes before scheduled time should we show a 'waiting' state
  preStartWindowMinutes = 15;
  feedbackSession: any = null;
  feedbackRating = 5;
  feedbackComment = '';
  submittingFeedback = false;
  feedbackClosing = false;
  startingSessionId: string | null = null;
  // for in-app Jitsi modal
  jitsiVisible = false;
  jitsiUrl: string | null = null;
  jitsiSessionId: string | null = null;
  jitsiJoinToken: string | null = null;
  // live clock used to drive time-dependent UI without reload
  now: Date = new Date();
  private nowTimer: any = null;
  // details overlay
  selectedSession: any = null;
  // editing state
  editingSession: any = null;
  editSubject = '';
  editScheduledAt = '';
  editDuration = 60;
  editNotes = '';
  // slot editing support
  public editingSlotOptions: any[] = [];
  public selectedEditSlot: string | null = null;

  // helper used by the template to avoid direct optional chaining checks
  public hasEditingSlots(): boolean { return Array.isArray(this.editingSlotOptions) && this.editingSlotOptions.length > 0; }
  public editingSlotOptionsSafe(): any[] { return this.editingSlotOptions || []; }
  // notification subscription and periodic refresh
  private notifSub: Subscription | null = null;
  private refreshTimer: any = null;
  // When a pending booked session is present but not yet in server list,
  // poll the server a few times to wait for eventual consistency.
  private pendingPollTimer: any = null;
  private pendingPollAttempts = 0;
  private dashboardViewHandler: any = null;

  get currentUser() {
    try {
      const u = localStorage.getItem('user');
      return u ? JSON.parse(u) : null;
    } catch { return null; }
  }

  isTutorForSession(s: any) {
    const user = this.currentUser;
    if (!user) return false;
    // If the current user is a tutor, the backend returns sessions filtered for
    // that tutor (the controller resolves the TutorProfile._id). In that case
    // it's safe to consider the session belonged to the current tutor.
    if (user.isTutor === true) return true;
    // Otherwise, session.tutorId may be an id string or object; also check populated tutor.user
    const tutorId = s.tutorId || s.tutor?._id || s.tutor?.userId || s.tutor?.user?._id;
    return String(tutorId) === String(user._id) || String(tutorId) === String(user.id);
  }

  canStartSession(s: any) {
    if (s.status !== 'scheduled') return false;
    const now = this.now || new Date();
    const scheduled = new Date(s.scheduledAt);
    const startWindow = new Date(scheduled.getTime() - 15 * 60000);
    const endWindow = new Date(scheduled.getTime() + 4 * 60 * 60000);
    return now >= startWindow && now <= endWindow;
  }

  startSession(s: any) {
    if (!s || !s._id) return;
    this.startingSessionId = s._id;
    this.sessionsService.start(s._id).subscribe({
      next: (res: any) => {
        this.startingSessionId = null;
        const url = res?.meetingUrl;
        const token = res?.joinToken || res?.token;
        const expires = res?.expiresAt || res?.meetingUrlExpiresAt || null;
        if (url) {
          // update local session state
          s.meetingUrl = url;
          if (token) s.joinToken = token;
          if (expires) s.meetingUrlExpiresAt = expires;
          s.status = 'in-progress';
          // refresh sessions from server so UI stays consistent
          this.reloadSessions();
          // refresh notifications immediately
          try { this.notificationsSvc.loadOnce(); } catch {}
          // broadcast event so other components can respond
          try { window.dispatchEvent(new CustomEvent('session:started', { detail: { sessionId: s._id, meetingUrl: url, joinToken: token, expiresAt: expires } })); } catch {}
          // open in-app Jitsi modal when users prefer in-app; fallback to new tab if iframe blocked
          this.jitsiUrl = url;
          this.jitsiVisible = true;
          this.jitsiSessionId = s._id;
          this.jitsiJoinToken = token || null;
        } else {
          this.toast.push('Meeting URL not returned', 'error');
        }
      },
      error: (err: any) => {
  this.startingSessionId = null;
  this.toast.push(err?.error?.message || 'Failed to start session', 'error');
      }
    });
  }

  joinSession(s: any) {
    // mark any related notifications as read (if present)
    try {
      const notifs = (this.notificationsSvc.notifications$ as any).getValue ? (this.notificationsSvc.notifications$ as any).getValue() : [];
      if (Array.isArray(notifs)) {
        const matched = notifs.filter((n: any) => n && n.data && String(n.data.sessionId) === String(s._id));
        matched.forEach((n: any) => {
          try { this.notificationsSvc.markRead(n._id || n.id).subscribe({ next: () => {}, error: () => {} }); } catch (e) {}
        });
        // server-side bulk mark as a convenience (will mark any notification with data.sessionId)
        try { this.notificationsSvc.markReadBySession(String(s._id)).subscribe({ next: () => {}, error: () => {} }); } catch (e) {}
      }
    } catch (e) {}

    const url = s.meetingUrl;
    const user = this.currentUser;
    if (user && user._id) {
      // if authenticated, request a short-lived join token from server (single-use) then open the join endpoint
      try {
        this.sessionsService.issueJoin(s._id).subscribe({ next: (res: any) => {
          const joinUrl = `${environment.apiUrl}/api/sessions/${s._id}/join?token=${encodeURIComponent(res.joinToken)}`;
          try { window.open(joinUrl, '_blank'); } catch { /* ignore */ }
        }, error: () => {
          // fallback to modal/opening meetingUrl if issuing token fails
          if (url) { this.jitsiUrl = url; this.jitsiVisible = true; }
          else this.toast.push('Failed to obtain join token', 'error');
        } });
      } catch (e) {
        if (url) { this.jitsiUrl = url; this.jitsiVisible = true; }
      }
    } else {
      // not authenticated: open in-app modal when meetingUrl present, otherwise suggest waiting
      if (url) {
        this.jitsiUrl = url;
        this.jitsiVisible = true;
      } else if (s.status === 'in-progress') {
        this.toast.push('Meeting URL not available yet', 'info');
      } else if (this.isWaitingForTutor(s)) {
        this.toast.push('Waiting for tutor to start the session', 'info');
      } else {
        this.toast.push('Session has not started yet', 'info');
      }
    }
  }

  isWaitingForTutor(s: any) {
    try {
      if (!s || !s.scheduledAt) return false;
      const now = this.now || new Date();
      const scheduled = new Date(s.scheduledAt);
      const preWindow = new Date(scheduled.getTime() - this.preStartWindowMinutes * 60000);
      return now >= preWindow && now < scheduled && s.status === 'scheduled' && !this.isTutorForSession(s);
    } catch (e) {
      return false;
    }
  }

  // whether the session time window is over (scheduledAt + durationMinutes)
  isSessionEnded(s: any) {
    try {
      if (!s || !s.scheduledAt) return false;
      const scheduled = new Date(s.scheduledAt).getTime();
      const dur = (s.durationMinutes ?? s.duration ?? 0) * 60000;
      if (!dur) return false; // unknown duration -> don't assume ended
      const end = scheduled + dur;
      const nowMs = (this.now || new Date()).getTime();
      return nowMs > end;
    } catch (e) { return false; }
  }

  ngOnInit() {
    try {
      const stored = localStorage.getItem('sessionsView');
      if (stored === 'student' || stored === 'tutor') this.sessionsView = stored;
    } catch (e) {}
    try {
      const storedFilter = localStorage.getItem('sessionsFilter');
      if (storedFilter === 'all' || storedFilter === 'upcoming' || storedFilter === 'past') this.filter = storedFilter as any;
    } catch (e) {}
  this.reloadSessions();
  // Some navigation state (history.state) may only be available a short moment
  // after component init in certain browsers / navigation timings. Schedule a
  // short delayed merge to catch any pending booked session that wasn't
  // available synchronously when reloadSessions() started.
  try { setTimeout(() => { try { this.mergePendingBookedSession(); } catch (e) {} }, 250); } catch (e) {}
    // If navigation state contains a newSession we defer merging until after
    // the server reload completes (mergePendingBookedSession will run after reload).
    try { const nav: any = (this.router as any).getCurrentNavigation ? (this.router as any).getCurrentNavigation() : null; try { if (nav && nav.extras && nav.extras.state && nav.extras.state.newSession) console.debug('[my-sessions] navigation contains newSession - deferring merge'); } catch(e){} } catch (e) {}

    // pending booked session will be merged after reloadSessions() completes
    // reload when we receive a session_started notification so Join becomes visible quickly
    try {
      this.notifSub = this.notificationsSvc.notifications$.subscribe(list => {
        if (!list || !Array.isArray(list)) return;
        const hasStart = list.some((n: any) => n && n.type === 'session_started');
        if (hasStart) this.reloadSessions();
      });
    } catch (e) {}
    // periodic refresh as a fallback (every 15s)
    try { this.refreshTimer = setInterval(() => this.reloadSessions(), 15000); } catch (e) {}
    // listen for cross-component session booked events so we reload immediately
    try {
      window.addEventListener('session:booked', this.onSessionBooked as EventListener);
    } catch (e) {}
    // listen for session started events (emitted via socket -> App)
    try {
      window.addEventListener('session:started', this.onSessionStarted as EventListener);
    } catch (e) {}
    // start live clock to drive time-sensitive UI
    try {
      this.nowTimer = setInterval(() => { this.now = new Date(); }, 1000);
    } catch (e) {}
  }

  ngOnDestroy() {
    try { this.notifSub?.unsubscribe(); } catch (e) {}
    try { if (this.refreshTimer) clearInterval(this.refreshTimer); } catch (e) {}
    try { if (this.pendingPollTimer) clearInterval(this.pendingPollTimer); } catch (e) {}
    try { window.removeEventListener('session:booked', this.onSessionBooked as EventListener); } catch (e) {}
  try { window.removeEventListener('session:started', this.onSessionStarted as EventListener); } catch (e) {}
  try { if (this.nowTimer) { clearInterval(this.nowTimer); this.nowTimer = null; } } catch (e) {}
    // removed dashboard view event subscription
  }

  // handler for window event dispatched when a session is booked elsewhere in the app
  onSessionBooked = (ev: any) => {
    try {
      // If the current user is a student, switch the view to student so they see their booking
      try {
        const u = this.currentUser;
        if (!u || u.isTutor !== true) {
          this.sessionsView = 'student';
          try { localStorage.setItem('sessionsView', 'student'); } catch (e) {}
        }
      } catch (e) {}
      // If the event included the created session, insert it optimistically
      try {
        const sess = ev && ev.detail ? ev.detail : null;
        if (sess && (sess._id || sess.id)) {
          // normalize
          if (!sess._id && sess.id) sess._id = sess.id;
          // persist a fallback so reload/merge can pick it up later if needed
          try { localStorage.setItem('lastBookedSession', JSON.stringify(sess)); } catch (e) {}
          const exists = (this.sessions || []).some((x:any) => String(x._id) === String(sess._id));
          if (!exists) this.sessions = [sess, ...this.sessions];
          // show upcoming sessions so students immediately see the booking
          try {
            const sdate = sess && sess.scheduledAt ? new Date(sess.scheduledAt) : null;
            if (sdate && sdate.getTime() > Date.now()) this.filter = 'upcoming';
          } catch (e) {}
          this.toast.push('Session booked', 'success');
          return;
        }
      } catch (e) {}
      // otherwise fallback to reloading from server
      this.reloadSessions();
    } catch (e) {}
  }

  // handler for session started events (socket -> App -> window event)
  onSessionStarted = (ev: any) => {
    try {
      const data = ev && ev.detail ? ev.detail : null;
      const sid = data && (data.sessionId || data._id || data.id) ? (data.sessionId || data._id || data.id) : null;
      if (!sid) return;
      const idx = (this.sessions || []).findIndex((x:any) => String(x._id) === String(sid));
      if (idx >= 0) {
        const s = this.sessions[idx];
        if (data.meetingUrl) s.meetingUrl = data.meetingUrl;
        if (data.joinToken) s.joinToken = data.joinToken;
        if (data.expiresAt) s.meetingUrlExpiresAt = data.expiresAt;
        s.status = 'in-progress';
        this.sessions[idx] = s;
        if (this.selectedSession && String(this.selectedSession._id) === String(sid)) this.selectedSession = s;
      } else {
        // Not found locally; refresh list to pick up authoritative session
        try { this.reloadSessions(); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

  reloadSessions() {
    // If we have a pending booked session (from navigation state or localStorage),
    // prefer to ensure we load the student view so the server list includes it.
    let pending = this.getPendingBookedSession();
    if (pending) {
      try {
        const u = this.currentUser;
        if (!u || u.isTutor !== true) {
          this.sessionsView = 'student';
          try { localStorage.setItem('sessionsView', 'student'); } catch (e) {}
        }
      } catch (e) {}
    }

    const role: 'tutor' | 'student' = this.sessionsView === 'tutor' ? 'tutor' : 'student';
    this.sessionsService.list(role).subscribe({ next: (list) => {
      const serverList = list || [];
      // Merge pending (if present) into authoritative server list so optimistic
      // inserts are not lost when the server list arrives.
      try {
        if (!pending) pending = this.getPendingBookedSession();
        if (pending && (pending._id || pending.id)) {
          if (!pending._id && pending.id) pending._id = pending.id;
          const exists = serverList.some((x:any) => String(x._id) === String(pending._id));
          if (exists) {
            // authoritative server list contains the session — use it and remove fallback
            this.sessions = serverList;
            try { localStorage.removeItem('lastBookedSession'); } catch (e) {}
            // stop any pending polling attempts
            try { if (this.pendingPollTimer) { clearInterval(this.pendingPollTimer); this.pendingPollTimer = null; this.pendingPollAttempts = 0; } } catch (e) {}
          } else {
            // server doesn't yet contain the session; keep optimistic pending at top
            // and keep persisted fallback so subsequent reloads can still merge it.
            console.debug('[my-sessions] pending session not in server list yet, keeping optimistic session', pending._id);
            this.sessions = [pending, ...serverList];
            // start polling to wait for the server to include the pending session
            try {
              if (!this.pendingPollTimer) {
                this.pendingPollAttempts = 0;
                this.pendingPollTimer = setInterval(() => {
                  try {
                    this.pendingPollAttempts++;
                    // limit attempts to avoid infinite polling (e.g., 6 tries = ~18s)
                    if (this.pendingPollAttempts > 6) {
                      clearInterval(this.pendingPollTimer);
                      this.pendingPollTimer = null;
                      this.pendingPollAttempts = 0;
                      console.debug('[my-sessions] stopped polling for pending session after max attempts', pending._id);
                      return;
                    }
                    this.sessionsService.list(role).subscribe({ next: (fresh:any[]) => {
                      const found = fresh && Array.isArray(fresh) ? fresh.some((x:any) => String(x._id) === String(pending._id)) : false;
                      if (found) {
                        // server now contains the session — adopt authoritative list and stop polling
                        this.sessions = fresh || [];
                        try { localStorage.removeItem('lastBookedSession'); } catch (e) {}
                        try { clearInterval(this.pendingPollTimer); this.pendingPollTimer = null; this.pendingPollAttempts = 0; } catch (e) {}
                      }
                    }, error: () => {} });
                  } catch (e) { /* ignore */ }
                }, 3000);
              }
            } catch (e) {}
          }
          try {
            const sdate = pending && pending.scheduledAt ? new Date(pending.scheduledAt) : null;
            if (sdate && sdate.getTime() > Date.now()) this.filter = 'upcoming';
          } catch (e) {}
        } else {
          this.sessions = serverList;
        }
      } catch (e) {
        this.sessions = serverList;
      }
    }, error: () => {} });
  }

  // Merge a pending booked session from router state or localStorage into this.sessions
  private mergePendingBookedSession() {
    // kept for backward compatibility: delegate to the same helper used by reload
    try {
      const pending = this.getPendingBookedSession();
      if (pending && (pending._id || pending.id)) {
        if (!pending._id && pending.id) pending._id = pending.id;
        const exists = (this.sessions || []).some((x:any) => String(x._id) === String(pending._id));
        if (!exists) this.sessions = [pending, ...this.sessions];
          // (no removal here — handled above only when server confirms)
        try {
          const sdate = pending && pending.scheduledAt ? new Date(pending.scheduledAt) : null;
          if (sdate && sdate.getTime() > Date.now()) this.filter = 'upcoming';
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Read a pending booked session from router navigation state, history.state or localStorage
  private getPendingBookedSession(): any {
    try {
      let pending: any = null;
      try {
        const nav: any = (this.router as any).getCurrentNavigation ? (this.router as any).getCurrentNavigation() : null;
        pending = nav && nav.extras && nav.extras.state ? nav.extras.state.newSession : null;
      } catch (e) { pending = null; }
      try {
        if (!pending && typeof history !== 'undefined' && (history as any).state && (history as any).state.newSession) {
          pending = (history as any).state.newSession;
        }
      } catch (e) {}
      try {
        if (!pending) {
          const raw = localStorage.getItem('lastBookedSession');
          if (raw) pending = JSON.parse(raw);
        }
      } catch (e) {}
      return pending || null;
    } catch (e) { return null; }
  }

  setSessionsView(v: 'student' | 'tutor') {
    this.sessionsView = v;
    try { localStorage.setItem('sessionsView', v); } catch (e) {}
    this.reloadSessions();
  }

  setFilter(f: 'all' | 'upcoming' | 'past') {
    this.filter = f;
    try { localStorage.setItem('sessionsFilter', f); } catch (e) {}
  }

  get visibleSessions() {
    const now = this.now || new Date();
    if (this.filter === 'all') return this.sessions;
    if (this.filter === 'upcoming') return this.sessions.filter(s => new Date(s.scheduledAt) > now);
    return this.sessions.filter(s => new Date(s.scheduledAt) <= now);
  }

  formatTime(s: any) {
    try {
      const d = new Date(s.scheduledAt);
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      // backend stores duration in `durationMinutes`
      const durVal = s.durationMinutes ?? s.duration ?? null;
      const dur = durVal ? ` (${durVal} min)` : '';
      return `${time}${dur}`;
    } catch {
      return '';
    }
  }

  openFeedback(s: any) {
    // Prevent tutors from opening feedback UI
    if (this.isTutorForSession(s)) {
      this.toast.push('Tutors cannot leave feedback for students', 'info');
      return;
    }
    // Prevent leaving feedback for cancelled sessions
    try {
      const st = s && (s.status || s.state || s.statusText);
      if (st === 'cancelled' || st === 'canceled') {
        this.toast.push('Cannot leave feedback for a cancelled session', 'info');
        return;
      }
    } catch (e) {}
    // Prevent opening feedback for sessions already rated
    try {
      if (s && s.hasFeedback) {
        this.toast.push('You have already rated this session', 'info');
        return;
      }
    } catch (e) {}
    this.feedbackSession = s;
    this.feedbackRating = 5;
    this.feedbackComment = '';
  }

  openEdit(s: any) {
    this.editingSession = { ...s };
    this.editSubject = s.subject || '';
    // ISO string without seconds for easy editing in datetime-local
    try { this.editScheduledAt = new Date(s.scheduledAt).toISOString().slice(0,16); } catch { this.editScheduledAt = ''; }
    this.editDuration = s.durationMinutes || s.duration || 60;
    this.editNotes = s.notes || '';
    this.selectedEditSlot = null;
    this.editingSlotOptions = [];
    // Try to fetch available slots for the tutor to allow moving the booking to another slot
    try {
      // Resolve TutorProfile._id (the Slot.tutorId stores the TutorProfile _id).
      const tutorIdCandidates = [s.tutor?._id, s.tutorId, s.tutor?.user?._id, s.tutor?.userId, s.tutor?._id?.$oid];
      let tutorId: any = null;
      for (const c of tutorIdCandidates) {
        if (!c) continue;
        // if object shape, try to extract _id field
        if (typeof c === 'object') {
          if (c._id) { tutorId = c._id; break; }
          if (c.id) { tutorId = c.id; break; }
        } else if (typeof c === 'string' && c.trim().length > 0) { tutorId = c; break; }
      }
      if (tutorId) {
        try {
          // fetch only available upcoming slots
          this.slotsService.tutorSlots(String(tutorId)).subscribe({ next: (list:any) => this.editingSlotOptions = list || [], error: () => this.editingSlotOptions = [] });
        } catch (e) { this.editingSlotOptions = []; }
      }
    } catch (e) {}
  }

  saveEdit() {
    if (!this.editingSession) return;
    const id = this.editingSession._id;
  // If user selected a new pre-created slot, book that slot and delete the old session
  if (this.selectedEditSlot) {
    const payload: any = { subject: this.editSubject, notes: this.editNotes };
    // Book the new slot
    const slotsSvc = (this as any).slotsService as any || null;
    if (!slotsSvc) {
      // fallback: call sessions update
      this.toast.push('Unable to access slots service', 'error');
      return;
    }
    // Prefer a server-side atomic switch endpoint to move the session to the new slot
    slotsSvc.switchSlot(this.selectedEditSlot, id).subscribe({ next: (res: any) => {
      this.toast.push('Session moved to new slot', 'success');
      this.editingSession = null;
      this.reloadSessions();
    }, error: (err: any) => {
      // fall back to trying to book then delete if switch endpoint fails
      const msg = err?.error?.message || err?.message || 'Failed to move session';
      this.toast.push(msg, 'error');
      this.reloadSessions();
    } });
    return;
  }
  // Manual edits are disabled — require selecting a pre-created slot
  this.toast.push('Please select one of the tutor\'s available slots to move the session', 'error');
  }

  cancelEdit() {
    this.editingSession = null;
  }

  confirmDelete(s: any) {
    // no-op (deprecated)
  }

  deleteSession(s: any) {
    if (!s || !s._id) return;
    this.sessionsService.delete(s._id).subscribe({ next: () => {
      this.toast.push('Session deleted', 'info');
      this.reloadSessions();
    }, error: (err: any) => this.toast.push(err?.error?.message || 'Failed to delete session', 'error') });
  }

  markComplete(s: any) {
    if (!s || !s._id) return;
    this.sessionsService.complete(s._id).subscribe({ next: (res: any) => {
      this.toast.push('Session marked complete', 'success');
      this.reloadSessions();
    }, error: (err: any) => this.toast.push(err?.error?.message || 'Failed to mark complete', 'error') });
  }

  viewDetails(s: any) {
    // open details overlay
    this.selectedSession = s;
  }

  submitFeedback() {
    if (!this.feedbackSession) return;
    // Double-check user role before submitting
    if (this.isTutorForSession(this.feedbackSession)) {
      this.toast.push('Tutors cannot leave feedback for students', 'error');
      this.feedbackSession = null;
      return;
    }
    // Determine tutorId to send: session may contain tutorId (TutorProfile._id) or a populated tutor object
    const sess: any = this.feedbackSession;
    let tutorId = sess.tutorId || sess.tutor?._id || sess.tutor?.user?._id || sess.tutor?._id || null;
    
    // Ensure tutorId is a string, not an object
    if (tutorId && typeof tutorId === 'object') {
      tutorId = tutorId._id || tutorId.id || String(tutorId);
    }
    
    if (!tutorId) {
      this.toast.push('Unable to determine tutor for this session', 'error');
      this.feedbackSession = null;
      return;
    }
    
    console.log('Sending tutorId:', tutorId, 'type:', typeof tutorId);

    // Validate rating is within 1..5
    const r = Number(this.feedbackRating || 0);
    if (!r || r < 1 || r > 5) {
      this.toast.push('Please provide a rating between 1 and 5', 'error');
      return;
    }

    const sid = this.feedbackSession?._id;
    // keep modal open while submitting to avoid flicker; disable submit via submittingFeedback
    this.submittingFeedback = true;
    this.feedbackSvc.leave(sid, String(tutorId), r, this.feedbackComment)
      .subscribe({ next: (res: any) => {
        // If server returned authoritative session, adopt it. Otherwise fall back to optimistic update.
        try {
          const serverSession = res && res.session ? res.session : null;
          if (serverSession && sid && String(serverSession._id || serverSession.id) === String(sid)) {
            // replace or upsert in sessions list
            const idx = this.sessions.findIndex((x:any) => String(x._id) === String(sid));
            if (idx >= 0) this.sessions[idx] = serverSession;
            else this.sessions = [serverSession, ...this.sessions];
            if (this.selectedSession && String(this.selectedSession._id) === String(sid)) this.selectedSession = serverSession;
          } else {
            // optimistic local update: mark session as having feedback so UI updates immediately
            if (sid && Array.isArray(this.sessions)) {
              const idx2 = this.sessions.findIndex((x:any) => String(x._id) === String(sid));
              if (idx2 >= 0) this.sessions[idx2].hasFeedback = true;
            }
            if (this.selectedSession && String(this.selectedSession._id) === String(sid)) this.selectedSession.hasFeedback = true;
          }
        } catch (e) {}
        // notify other components (tutor card) to refresh their display
        try { if (res && res.tutor && (res.tutor._id || res.tutor.id)) {
          const tid = res.tutor._id || res.tutor.id;
          window.dispatchEvent(new CustomEvent('tutor:updated', { detail: { tutorId: tid, averageRating: res.tutor.averageRating || res.tutor.avgRating || res.tutor.avgRating || 0, ratingCount: res.tutor.ratingCount || res.tutor.cnt || res.tutor.ratingCount || 0 } }));
        } } catch (e) {}
        // Show success message
        this.toast.push('Feedback submitted successfully!', 'success');
        this.submittingFeedback = false;
        
        // Reset form fields
        this.feedbackRating = 5;
        this.feedbackComment = '';
        
        // Close modal immediately
        this.feedbackSession = null;
        this.feedbackClosing = false;
        
        // Refresh sessions list to show updated hasFeedback status
        this.reloadSessions();
      }, error: (err: any) => {
        this.submittingFeedback = false;
        const errorMessage = err?.error?.message || err?.message || 'Failed to submit feedback. Please try again.';
        this.toast.push(errorMessage, 'error');
        console.error('Error submitting feedback:', err);
        // Do not automatically re-open the modal; user can re-open manually and retry
      } });
  }

  getOtherPartyName(s: any) {
    const user = this.currentUser;
    if (!user) return s.tutor?.name || s.tutorName || s.studentName || 'Participant';
    const amTutor = (user.isTutor === true) || this.isTutorForSession(s);
    if (amTutor) {
      // show student name
      return s.student?.fullName || s.studentName || (s.studentId ? String(s.studentId).slice(-6) : 'Student');
    }
    // show tutor name
    return this.getTutorName(s);
  }

  // helper to consistently resolve a tutor's display name for templates
  getTutorName(s: any) {
    try {
      if (!s) return 'Tutor';
      // Try multiple shapes the backend might return:
      // - session.tutor.user.fullName
      // - session.tutor.fullName / tutor.name
      // - session.tutorId.userId.fullName (older population shape)
      // - top-level session.tutorName provided by the controller
      const candidates = [
        s.tutor?.user?.fullName,
        s.tutor?.user?.full_name,
        s.tutor?.fullName,
        s.tutor?.name,
        s.tutorName,
        s.tutorId?.userId?.fullName,
        s.tutorId?.user?.fullName,
        s.tutorId?.fullName,
        s.tutorId?._id
      ];
      for (const c of candidates) {
        if (c && typeof c === 'string' && c.trim()) return c;
      }
      return 'Tutor';
    } catch (e) { return 'Tutor'; }
  }

  // derive initials for avatar from the tutor name (fallback to 'T')
  getTutorInitials(s: any) {
    try {
      const name = this.getTutorName(s);
      if (!name || typeof name !== 'string') return 'T';
      const parts = name.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return 'T';
      if (parts.length === 1) return parts[0].slice(0,1).toUpperCase();
      return (parts[0].slice(0,1) + parts[parts.length-1].slice(0,1)).toUpperCase();
    } catch (e) { return 'T'; }
  }

  openExternal(url: string | null) {
    if (!url) return;
    try {
      // if session has a joinToken, open the server join endpoint instead (so server can verify token)
      const s = this.selectedSession;
      if (s && s._id && s.joinToken) {
        const joinUrl = `${environment.apiUrl}/api/sessions/${s._id}/join?token=${encodeURIComponent(s.joinToken)}`;
        window.open(joinUrl, '_blank');
        return;
      }
      window.open(url, '_blank');
    } catch { /* ignore */ }
  }

  async copyMeetingLink(url: string | null) {
    if (!url) return this.toast.push('No meeting link available', 'error');
    try {
      await navigator.clipboard.writeText(url);
      this.toast.push('Meeting link copied', 'info');
    } catch (e) {
      this.toast.push('Failed to copy link', 'error');
    }
  }

  closeJitsi() {
    this.jitsiVisible = false;
    this.jitsiSessionId = null;
    this.jitsiJoinToken = null;
  }
}
