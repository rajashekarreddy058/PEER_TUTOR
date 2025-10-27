import { Component, inject, EventEmitter, Output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-become-tutor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './become-tutor.html',
  styleUrls: ['./become-tutor.css']
})
export class BecomeTutorPage implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);

  subjects: any[] = [];
  selectedSubjects: string[] = [];
  bio = '';
  // keep an optional property to avoid compiler errors if any template bindings remain
  hourlyRate?: number | null = null;
  // UI state
  errorMessage = '';
  isSubmitting = false;

  @Output() closeEvent = new EventEmitter<void>();
  @Output() successEvent = new EventEmitter<void>();

  ngOnInit() {
    // fetch subjects from API (or use placeholder)
    this.api.get('/subjects').subscribe({
      next: (res: any) => {
        if (Array.isArray(res) && res.length) {
          this.subjects = res;
        } else {
          this.useFallbackSubjects();
        }
      },
      error: () => this.useFallbackSubjects()
    });
  }

  useFallbackSubjects() {
    this.subjects = [
      { id: 'bio', name: 'Biology', description: 'Molecular Biology, Genetics, Ecology' },
      { id: 'chem', name: 'Chemistry', description: 'Organic, Inorganic, Physical Chemistry' },
      { id: 'cs', name: 'Computer Science', description: 'Programming, Algorithms, Data Structures' },
      { id: 'econ', name: 'Economics', description: 'Microeconomics, Macroeconomics' },
      { id: 'eng', name: 'English', description: 'Writing, Literature, Grammar' },
      { id: 'hist', name: 'History', description: 'World History, American History' },
      { id: 'math', name: 'Mathematics', description: 'Algebra, Calculus, Statistics' },
      { id: 'phys', name: 'Physics', description: 'Mechanics, Electromagnetism' }
    ];
  }

  toggleSubject(name: string) {
    if (this.selectedSubjects.includes(name)) {
      this.selectedSubjects = this.selectedSubjects.filter(s => s !== name);
    } else {
      this.selectedSubjects.push(name);
    }
  }

  onClose() {
    // emit close so parent can hide modal
    this.closeEvent.emit();
  }

  submit() {
    // local validation
    this.errorMessage = '';
    if (!this.selectedSubjects || !this.selectedSubjects.length) {
      this.errorMessage = 'Please select at least one subject you can teach.';
      return;
    }
    if (!this.hourlyRate || this.hourlyRate < 5 || this.hourlyRate > 200) {
      this.errorMessage = 'Please set an hourly rate between $5 and $200.';
      return;
    }
    const body = { subjects: this.selectedSubjects, bio: this.bio, hourlyRate: this.hourlyRate };
    this.isSubmitting = true;
    this.api.post('/tutors/become', body).subscribe({
      next: (res: any) => {
        // mark local user as tutor so UI updates immediately
        try {
          const user = JSON.parse(localStorage.getItem('user') || 'null');
          if (user) { user.isTutor = true; localStorage.setItem('user', JSON.stringify(user)); }
        } catch {}

        // Extract created tutor object from response if present
        const createdTutor = res?.tutor || res?.data || res || null;

        // notify other parts of the app that a tutor was created and include the tutor payload so listeners can update immediately
        try { window.dispatchEvent(new CustomEvent('tutor:created', { detail: createdTutor })); } catch {}

        this.successEvent.emit();
        this.closeEvent.emit();
      },
      error: (err: any) => {
        // log full error to console for debugging (network/CORS/server errors)
        console.error('Become tutor error:', err);
        const msg = err?.error?.message || err?.message || 'Failed to create tutor profile';
        this.errorMessage = msg;
      },
      complete: () => { this.isSubmitting = false; }
    });
  }
}
