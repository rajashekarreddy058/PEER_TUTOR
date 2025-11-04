import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notifications.html',
  styleUrls: ['./notifications.css']
})
export class NotificationsPage implements OnInit {
  private notificationService = inject(NotificationService);
  private router = inject(Router);

  notifications: any[] = [];

  ngOnInit() {
    this.loadNotifications();
  }

  loadNotifications() {
    this.notificationService.notifications$.subscribe((notifications) => {
      this.notifications = notifications || [];
    });
  }

  markAsRead(notification: any) {
    this.notificationService.markRead(notification.id).subscribe({
      next: () => {
        notification.read = true;
      },
      error: (err: any) => {
        console.error('Failed to mark notification as read:', err);
      }
    });
  }

  markAllRead() {
    this.notificationService.markAllRead().subscribe({
      next: () => {
        this.notifications.forEach(notification => {
          notification.read = true;
        });
      },
      error: (err: any) => {
        console.error('Failed to mark all notifications as read:', err);
      }
    });
  }

  deleteNotification(notification: any) {
    this.notificationService.deleteNotification(notification.id).subscribe({
      next: () => {
        this.notifications = this.notifications.filter(n => n.id !== notification.id);
      },
      error: (err: any) => {
        console.error('Failed to delete notification:', err);
      }
    });
  }

  joinFromNotification(notification: any) {
    const data = notification?.data || {};
    if (data.sessionId) {
      // Navigate to session or open meeting
      this.router.navigate(['/sessions']);
    }
  }

  refreshNotifications() {
    this.notificationService.loadOnce();
  }

  hasUnreadNotifications(): boolean {
    return this.notifications.some(notification => !notification.read);
  }

  getNotificationIcon(type: string): string {
    const iconMap: { [key: string]: string } = {
      'session_started': 'bi-camera-video',
      'session_created': 'bi-calendar-plus',
      'session_reminder': 'bi-bell',
      'feedback': 'bi-star',
      'general': 'bi-info-circle',
      'urgent': 'bi-exclamation-triangle'
    };
    return iconMap[type] || 'bi-bell';
  }

  getPriorityClass(priority: string): string {
    const classMap: { [key: string]: string } = {
      'low': 'bg-light text-dark',
      'medium': 'bg-primary',
      'high': 'bg-warning text-dark',
      'urgent': 'bg-danger'
    };
    return classMap[priority] || 'bg-secondary';
  }

  formatTime(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));

    if (diffInMinutes < 1) return 'Just now';
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
    if (diffInMinutes < 10080) return `${Math.floor(diffInMinutes / 1440)}d ago`;
    
    return date.toLocaleDateString();
  }
}
