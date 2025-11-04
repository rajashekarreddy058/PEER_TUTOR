import { Injectable } from '@angular/core';
import { ApiService } from './api.service';
import { tap, switchMap } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private api: ApiService) {}

  signIn(email: string, password: string) {
    return this.api.post<{ token: string; user?: any }>('/auth/signin', { email, password }).pipe(
      tap((res: { token: string; user?: any }) => {
        localStorage.setItem('token', res.token);
        if (res.user) {
          localStorage.setItem('user', JSON.stringify(res.user));
        }
        try {
          // notify other parts of the app that sign-in occurred (so they can connect sockets / start notifications)
          try { window.dispatchEvent(new CustomEvent('auth:signed_in', { detail: { token: res.token, user: res.user } })); } catch (e) {}
        } catch (e) {}
      })
    );
  }

  signUp(email: string, password: string, firstName: string, surname: string) {
    // Perform signup then immediately sign in so the app receives and stores the
    // authentication token and user object. Caller will receive the signIn result.
    return this.api.post('/auth/signup', { email, password, firstName, surname }).pipe(
      switchMap(() => this.signIn(email, password))
    );
  }

  signOut() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }

  isAuthenticated(): boolean {
    return !!localStorage.getItem('token');
  }

  getToken(): string | null {
    return localStorage.getItem('token');
  }
}


