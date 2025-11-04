import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';

interface UserProfile {
  id: string;
  firstName: string;
  surname: string;
  fullName: string;
  email: string;
  profilePicture?: string;
  bio?: string;
  grade?: string;
  subjects?: string[];
  educationalInstitute?: string;
  joinDate: string;
  isTutor: boolean;
}

@Component({
  selector: 'app-student-profile',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './student-profile.html',
  styleUrls: ['./student-profile.css']
})
export class StudentProfilePage implements OnInit {
  private auth = inject(AuthService);
  private api = inject(ApiService);
  private router = inject(Router);

  profile: UserProfile | null = null;
  editing = false;
  loading = false;
  error = '';
  selectedFile: File | null = null;
  previewUrl: string | null = null;

  // Form fields for editing
  editFirstName = '';
  editSurname = '';
  editBio = '';
  editGrade = '';
  editEducationalInstitute = '';
  editSubjects: string[] = [];

  ngOnInit() {
    this.loadProfile();
  }

  loadProfile() {
    this.loading = true;
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (user.id) {
      this.profile = user;
      this.populateEditFields();
    }
    this.loading = false;
  }

  populateEditFields() {
    if (this.profile) {
      this.editFirstName = this.profile.firstName;
      this.editSurname = this.profile.surname;
      this.editBio = this.profile.bio || '';
      this.editGrade = this.profile.grade || '';
      this.editEducationalInstitute = this.profile.educationalInstitute || '';
      this.editSubjects = [...(this.profile?.subjects || [])];
    }
  }

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.selectedFile = file;
      const reader = new FileReader();
      reader.onload = (e: any) => {
        this.previewUrl = e.target.result;
        // Auto-save the profile picture when selected
        this.saveProfilePicture();
      };
      reader.readAsDataURL(file);
    }
  }

  removeProfilePicture() {
    this.selectedFile = null;
    this.previewUrl = null;
    if (this.profile) {
      this.profile.profilePicture = undefined;
    }
  }

  triggerFileInput() {
    const fileInput = document.getElementById('profile-picture-input-main') as HTMLInputElement;
    if (fileInput) {
      fileInput.click();
    }
  }

  saveProfilePicture() {
    if (!this.profile) return;

    this.loading = true;
    this.error = '';

    // Upload profile picture if selected
    if (this.selectedFile) {
      const formData = new FormData();
      formData.append('profilePicture', this.selectedFile);
      
      this.api.postFile(`/users/${this.profile.id}/profile-picture`, formData).subscribe({
        next: (response: any) => {
          if (this.profile) {
            const updatedUser = { ...this.profile, profilePicture: response.profilePicture };
            localStorage.setItem('user', JSON.stringify(updatedUser));
            this.profile = updatedUser;
            this.previewUrl = null;
            this.selectedFile = null;
            this.loading = false;
          }
        },
        error: (err: any) => {
          // Fallback to base64 if file upload fails
          const updateData = {
            profilePicture: this.previewUrl || this.profile?.profilePicture
          };

          this.api.put(`/users/${this.profile?.id}`, updateData).subscribe({
            next: (response: any) => {
              const updatedUser = { ...this.profile, ...response };
              localStorage.setItem('user', JSON.stringify(updatedUser));
              this.profile = updatedUser;
              this.previewUrl = null;
              this.selectedFile = null;
              this.loading = false;
            },
            error: (err: any) => {
              this.error = err?.error?.message || 'Failed to update profile picture';
              this.loading = false;
            }
          });
        }
      });
    } else {
      // Just update the profile without uploading
      const updateData = {
        profilePicture: this.profile.profilePicture
      };

      this.api.put(`/users/${this.profile.id}`, updateData).subscribe({
        next: (response: any) => {
          const updatedUser = { ...this.profile, ...response };
          localStorage.setItem('user', JSON.stringify(updatedUser));
          this.profile = updatedUser;
          this.loading = false;
        },
        error: (err: any) => {
          this.error = err?.error?.message || 'Failed to update profile picture';
          this.loading = false;
        }
      });
    }
  }

  addSubject() {
    const subject = prompt('Enter a subject:');
    if (subject && subject.trim() && !this.editSubjects.includes(subject.trim())) {
      this.editSubjects.push(subject.trim());
    }
  }

  removeSubject(index: number) {
    this.editSubjects.splice(index, 1);
  }

  saveProfile() {
    if (!this.profile) return;

    this.loading = true;
    this.error = '';

    const updateData = {
      firstName: this.editFirstName,
      surname: this.editSurname,
      bio: this.editBio,
      grade: this.editGrade,
      educationalInstitute: this.editEducationalInstitute,
      subjects: this.editSubjects,
      profilePicture: this.previewUrl || this.profile.profilePicture
    };

    // Update profile data
    this.api.put(`/users/${this.profile.id}`, updateData).subscribe({
      next: (response: any) => {
        // Update local storage
        const updatedUser = { ...this.profile, ...response };
        localStorage.setItem('user', JSON.stringify(updatedUser));
        this.profile = updatedUser;
        this.editing = false;
        this.loading = false;
      },
      error: (err: any) => {
        this.error = err?.error?.message || 'Failed to update profile';
        this.loading = false;
      }
    });

    // Upload profile picture if selected
    if (this.selectedFile) {
      const formData = new FormData();
      formData.append('profilePicture', this.selectedFile);
      
      this.api.postFile(`/users/${this.profile.id}/profile-picture`, formData).subscribe({
        next: (response: any) => {
          if (this.profile) {
            this.profile.profilePicture = response.profilePicture;
            localStorage.setItem('user', JSON.stringify(this.profile));
          }
        },
        error: (err: any) => {
          console.error('Failed to upload profile picture:', err);
        }
      });
    }
  }

  cancelEdit() {
    this.editing = false;
    this.selectedFile = null;
    this.previewUrl = null;
    this.populateEditFields();
  }

  getProfilePictureUrl(): string {
    if (this.previewUrl) return this.previewUrl;
    if (this.profile?.profilePicture) return this.profile.profilePicture;
    return 'https://via.placeholder.com/150/4f46e5/ffffff?text=' + (this.profile?.firstName?.charAt(0) || 'U');
  }

  getJoinDateFormatted(): string {
    if (!this.profile?.joinDate) return '';
    return new Date(this.profile.joinDate).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  get hasSubjects(): boolean {
    return !!(this.profile?.subjects && this.profile.subjects.length > 0);
  }

  signOut() {
    this.auth.signOut();
    this.router.navigateByUrl('/signin');
  }
}
