import { Component, signal, inject, OnInit } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from './services/auth.service';
import { environment } from '../environments/environment';
import { NotificationService } from './services/notification.service';
import { SocketService } from './services/socket.service';
import { BecomeTutorPage } from './pages/become-tutor/become-tutor';
import { ToastsComponent } from './components/toasts/toasts';

@Component({
  selector: 'app-root',
  imports: [CommonModule, RouterOutlet, RouterLink, BecomeTutorPage, ToastsComponent],
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App implements OnInit {
  protected readonly title = signal('frontend');
  showNotifications = false;
  showBecomeModal = false;
  unreadCount = 0;
  notifications: Array<any> = [];
  private auth = inject(AuthService);
  private notificationsSvc = inject(NotificationService);
  private socketSvc = inject(SocketService);
  private router = inject(Router);

  // Expose services globally for simple page wiring prior to auth UI
  constructor() {
    // Lazy injector to avoid hard coupling in page components
    setTimeout(async () => {
      try {
  const { SessionsService } = await import('./services/sessions.service');
  const { ApiService } = await import('./services/api.service');
        // Create a tiny injector using the global app instance
        const api = new ApiService();
  (window as any).ngSessionsService = new SessionsService(api as any);
      } catch {}
    }, 0);
  }

  ngOnInit() {
    // start notifications polling when authenticated
    if (this.isAuthed()) this.initializeNotifications();

    // Listen for sign-in events so we can connect sockets when a user signs in at runtime
    try {
      window.addEventListener('auth:signed_in', (ev: any) => {
        try { this.initializeNotifications(); } catch (e) {}
      });
    } catch (e) {}
  }

  private initializeNotifications() {
    // connect socket with current token
    try { this.socketSvc.connect(localStorage.getItem('token')).catch((e: any) => {}); } catch {}

    // listen for server push events
    try { this.socketSvc.on('session_started', (data: any) => { try { window.dispatchEvent(new CustomEvent('session:started', { detail: data })); } catch {} }); } catch {}
    try { this.socketSvc.on('session_created', (data: any) => { try { window.dispatchEvent(new CustomEvent('session:booked', { detail: data })); } catch {} }); } catch {}
    try { this.notificationsSvc.start(); } catch {}

    // subscribe to notification streams
    try {
      this.notificationsSvc.notifications$.subscribe((list) => {
        // map into enhanced shape with new fields
        this.notifications = (list || []).map((n: any) => ({ 
          id: n._id || n.id, 
          title: n.title || n.type, 
          body: n.message || n.data?.subject || '', 
          time: new Date(n.createdAt).toLocaleString(), 
          unread: !n.read, 
          read: n.read,
          priority: n.priority || 'medium',
          category: n.category || 'session',
          type: n.type,
          data: n.data,
          createdAt: n.createdAt
        }));
      });
    } catch (e) {}

    // Subscribe to unread count
    try { this.notificationsSvc.unreadCount$.subscribe((count) => { this.unreadCount = count; }); } catch (e) {}
  }

  joinFromNotification(n: any) {
    const data = n?.data || {};
    // mark notification read in backend and locally
    try {
      if (n?.id) {
        this.notificationsSvc.markRead(n.id).subscribe({ next: () => {
          // update local list
          this.notifications = this.notifications.map(item => item.id === n.id ? { ...item, unread: false } : item);
        }, error: () => {} });
      }
    } catch {}

    // Prefer server join endpoint when we have sessionId + joinToken
    if (data.sessionId && data.joinToken) {
      const joinUrl = `${environment.apiUrl}/api/sessions/${data.sessionId}/join?token=${encodeURIComponent(data.joinToken)}`;
      try { window.open(joinUrl, '_blank'); } catch {}
      return;
    }
    if (data.meetingUrl) {
      try { window.open(data.meetingUrl, '_blank'); } catch {}
      return;
    }
    // nothing to do
  }

  isTutor() {
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      return !!user?.isTutor;
    } catch {
      return false;
    }
  }

  isAuthed() {
    return this.auth.isAuthenticated();
  }

  get fullName() {
    // If you have a way to fetch user's name from localStorage or API, use it here
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      return user?.fullName || user?.full_name || null;
    } catch {
      return null;
    }
  }

  signOut() {
    this.auth.signOut();
    this.router.navigateByUrl('/signin');
  }

  openBecomeModal() {
    this.showBecomeModal = true;
  }

  onBecomeClose() {
    this.showBecomeModal = false;
  }

  onBecomeSuccess() {
    this.showBecomeModal = false;
    // optionally refresh profile or show a toast
  }

  markAllRead() {
    this.notificationsSvc.markAllRead().subscribe({
      next: () => {
        this.notifications = this.notifications.map(n => ({ ...n, read: true, unread: false }));
        this.unreadCount = 0;
      },
      error: () => {}
    });
  }

  markAsRead(notification: any) {
    this.notificationsSvc.markRead(notification.id).subscribe({
      next: () => {
        this.notifications = this.notifications.map(n => 
          n.id === notification.id ? { ...n, read: true, unread: false } : n
        );
        this.unreadCount = Math.max(0, this.unreadCount - 1);
      },
      error: () => {}
    });
  }

  deleteNotification(notification: any) {
    this.notificationsSvc.deleteNotification(notification.id).subscribe({
      next: () => {
        this.notifications = this.notifications.filter(n => n.id !== notification.id);
        if (!notification.read) {
          this.unreadCount = Math.max(0, this.unreadCount - 1);
        }
      },
      error: () => {}
    });
  }

  getNotificationIcon(type: string): string {
    const iconMap: { [key: string]: string } = {
      'session_booked': 'bi-calendar-check',
      'session_cancelled': 'bi-calendar-x',
      'session_completed': 'bi-check-circle',
      'session_started': 'bi-play-circle',
      'session_reminder': 'bi-clock',
      'feedback_received': 'bi-star',
      'tutor_available': 'bi-person-check',
      'system_announcement': 'bi-megaphone'
    };
    return iconMap[type] || 'bi-bell';
  }

  getPriorityClass(priority: string): string {
    const classMap: { [key: string]: string } = {
      'low': 'bg-secondary',
      'medium': 'bg-primary',
      'high': 'bg-warning',
      'urgent': 'bg-danger'
    };
    return classMap[priority] || 'bg-primary';
  }

  formatTime(date: string | Date): string {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  }
}
