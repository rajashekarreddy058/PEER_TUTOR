import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TutorsService } from '../../services/tutors.service';
import { AdminJoinlogsPage } from '../admin-joinlogs/admin-joinlogs';

@Component({
  selector: 'app-admin',
  imports: [CommonModule, AdminJoinlogsPage],
  templateUrl: './admin.html',
  styleUrls: ['./admin.css']
})
export class Admin implements OnInit {
  private tutors = inject(TutorsService);
  list: any[] = [];
  loading = true;
  showJoinlogs = false;

  ngOnInit() {
    this.tutors.list().subscribe({
      next: (res) => this.list = res || [],
      complete: () => this.loading = false
    });
  }
}
