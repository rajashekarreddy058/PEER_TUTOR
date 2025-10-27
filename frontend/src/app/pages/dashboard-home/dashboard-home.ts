import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StudentDashboard } from '../student-dashboard/student-dashboard';
import { TutorDashboard } from '../tutor-dashboard/tutor-dashboard';
import { TutorsService } from '../../services/tutors.service';

@Component({
  selector: 'app-dashboard-home',
  standalone: true,
  imports: [CommonModule, StudentDashboard, TutorDashboard],
  template: `
    <div class="d-flex justify-content-end align-items-center mb-3" *ngIf="hasTutorRole">
      <div class="me-3">
        <span class="viewing-label">{{ viewingLabel }}</span>
      </div>
      <div class="btn-group" role="group" aria-label="dashboard view toggle">
        <button type="button" class="btn btn-sm view-toggle-btn" [ngClass]="{ 'active': activeView==='student' }" (click)="setView('student')">Student view</button>
        <button type="button" class="btn btn-sm view-toggle-btn" [ngClass]="{ 'active': activeView==='tutor' }" (click)="setView('tutor')">Tutor view</button>
      </div>
    </div>

    <ng-container *ngIf="activeView === 'tutor'; else studentTpl">
      <app-tutor-dashboard></app-tutor-dashboard>
    </ng-container>
    <ng-template #studentTpl>
      <app-student-dashboard></app-student-dashboard>
    </ng-template>
  `
})
export class DashboardHome implements OnInit {
  isTutor = false;
  // optimistic local flag: read localStorage so we can avoid flicker when user previously became a tutor
  hasTutorRole = this.localFlag();
  // initialize activeView from stored preference (use tutor only if local flag allows)
  activeView: 'student' | 'tutor' = ((): 'student' | 'tutor' => {
    try {
      const stored = localStorage.getItem('dashboardView');
      if (stored === 'tutor' && this.localFlag()) return 'tutor';
    } catch {}
    return 'student';
  })();
  // If the local flag indicates tutor, allow immediate render while server check runs
  roleChecked = this.hasTutorRole;
  private tutors = inject(TutorsService);

  ngOnInit() {
    // Try authoritative server check, fall back to localStorage
    try {
  this.tutors.me().subscribe({ next: (tp: any) => { this.isTutor = !!tp; this.afterRoleCheck(); }, error: () => { this.isTutor = this.localFlag(); this.afterRoleCheck(); } });
    } catch (e) {
      this.isTutor = this.localFlag();
      this.afterRoleCheck();
    }
  }

  afterRoleCheck() {
    // hasTutorRole indicates user can view tutor UI; combine server result with local optimistic flag
    this.hasTutorRole = !!this.isTutor || this.hasTutorRole;
    // initialize activeView from stored preference or default
    try {
      const stored = localStorage.getItem('dashboardView');
      if (stored === 'tutor' && this.hasTutorRole) this.activeView = 'tutor';
      else if (!stored) this.activeView = this.hasTutorRole ? 'tutor' : 'student';
    } catch {
      this.activeView = this.hasTutorRole ? 'tutor' : 'student';
    }
    this.roleChecked = true;
  }

  setView(v: 'student' | 'tutor') {
    if (v === 'tutor' && !this.hasTutorRole) return;
    this.activeView = v;
    try { localStorage.setItem('dashboardView', v); } catch {}
    // no global event dispatch — views are stored in localStorage and pages read from that or local toggles
  }

  get viewingLabel() {
    return this.activeView === 'tutor' ? 'Viewing as Tutor' : 'Viewing as Student';
  }

  localFlag() {
    try {
      const u = localStorage.getItem('user');
      const user = u ? JSON.parse(u) : null;
      return !!user?.isTutor;
    } catch { return false; }
  }
}
