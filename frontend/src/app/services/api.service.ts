import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { delay } from 'rxjs/operators';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = (window as any).__API_BASE_URL__ || `${environment.apiUrl}/api`;
  // Enable a quick local mock by setting `window.__API_BASE_URL__ = 'mock'` in index.html
  private useMock = typeof (window as any).__API_BASE_URL__ !== 'undefined' && (window as any).__API_BASE_URL__ === 'mock';

  post<T>(path: string, body: any) {
    // Simple dev mock for auth endpoints when backend is not present
    if (this.useMock && path.startsWith('/auth')) {
      // fake network delay
      if (path === '/auth/signup') {
        const user = { id: Date.now(), fullName: body.fullName || body.name || body.email, email: body.email };
        // persist mocked user to localStorage so signin can work
        localStorage.setItem('mock_user', JSON.stringify({ ...user, password: body.password }));
        return of({ ok: true, user }).pipe(delay(350)) as any;
      }

      if (path === '/auth/signin') {
        const stored = localStorage.getItem('mock_user');
        const parsed = stored ? JSON.parse(stored) : null;
        if (parsed && parsed.email === body.email && parsed.password === body.password) {
          // return a fake token + user
          return of({ ok: true, token: 'mock-token', user: { id: parsed.id, fullName: parsed.fullName, email: parsed.email } }).pipe(delay(250)) as any;
        }
        return throwError(() => new Error('Invalid credentials')).pipe(delay(200));
      }
    }

    const token = localStorage.getItem('token');
    const headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined;
    return this.http.post<T>(`${this.baseUrl}${path}`, body, headers ? { headers } : {});
  }

  get<T>(path: string) {
    const token = localStorage.getItem('token');
    const headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined;
    return this.http.get<T>(`${this.baseUrl}${path}`, headers ? { headers } : {});
  }

  put<T>(path: string, body: any) {
    const token = localStorage.getItem('token');
    const headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined;
    return this.http.put<T>(`${this.baseUrl}${path}`, body, headers ? { headers } : {});
  }

  delete<T>(path: string) {
    const token = localStorage.getItem('token');
    const headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined;
    return this.http.delete<T>(`${this.baseUrl}${path}`, headers ? { headers } : {});
  }

  postFile<T>(path: string, formData: FormData) {
    const token = localStorage.getItem('token');
    const headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined;
    return this.http.post<T>(`${this.baseUrl}${path}`, formData, headers ? { headers } : {});
  }
}


