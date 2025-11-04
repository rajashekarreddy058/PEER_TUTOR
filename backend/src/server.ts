import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createServer } from 'http';
import * as socketio from 'socket.io';
// socket.io types sometimes don't line up with transpilation settings across projects.
// Use a resilient runtime import: prefer the exported Server class but fall back to the
// namespace object when necessary.
const IOServer: any = (socketio as any).Server || (socketio as any).default || socketio;
import { setIo } from './lib/socket';
import jwt from 'jsonwebtoken';

import { router as authRoutes } from './routes/auth.routes';
import { router as tutorRoutes } from './routes/tutor.routes';
import { router as sessionRoutes } from './routes/session.routes';
import { router as feedbackRoutes } from './routes/feedback.routes';
import { router as dashboardRoutes } from './routes/dashboard.routes';
import { router as notificationRoutes } from './routes/notification.routes';
import { router as adminRoutes } from './routes/admin.routes';
import { router as slotRoutes } from './routes/slot.routes';
import { router as sessionRecordingRoutes } from './routes/session-recording.routes';
import { router as chatRoutes } from './routes/chat.routes';
import { router as recurringSessionsRoutes } from './routes/recurring-sessions.routes';
import { router as userRoutes } from './routes/user.routes';

dotenv.config();

const app = express();
// Configure CORS early so it applies to all routes
// FRONTEND_ORIGINS can be a comma-separated list of allowed origins, e.g.
// FRONTEND_ORIGINS="https://peer-frontend-hscj.onrender.com,https://peer-frontend-other.onrender.com"
// Set FRONTEND_ALLOW_ALL=true to allow all origins (use only for quick testing)
const rawFrontendOrigins = process.env.FRONTEND_ORIGINS || 'https://peer-frontend-hscj.onrender.com';
// determine environment early so we can conditionally add dev origins
const isDev = String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
const allowedOrigins = rawFrontendOrigins.split(',').map(s => s.trim()).filter(Boolean);
// When running in development, add common localhost dev origins so Socket.IO (which
// expects an array) will allow dev frontend at http://localhost:4200
if (isDev) {
  const devLocalOrigins = ['http://localhost:4200', 'http://127.0.0.1:4200'];
  devLocalOrigins.forEach(o => { if (allowedOrigins.indexOf(o) === -1) allowedOrigins.push(o); });
}
const allowAll = String(process.env.FRONTEND_ALLOW_ALL || '').toLowerCase() === 'true';

const corsOptions = {
  origin: function (origin: any, callback: any) {
    // allow requests with no origin (like curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowAll) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
    // In development, also allow local dev origins (localhost / 127.0.0.1)
    if (isDev) {
      try {
        const host = origin.split('://')[1];
        if (host && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))) {
          console.debug('CORS allowing dev origin:', origin);
          return callback(null, true);
        }
      } catch (e) {
        // fall-through to block
      }
    }
    console.warn('CORS blocked request from origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
};
app.use(cors(corsOptions));
console.log('CORS configured. allowedOrigins=', allowedOrigins, 'allowAll=', allowAll);
app.use(express.json());
app.use(morgan('dev'));
const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
  console.error('Missing MONGO_URI environment variable. Set MONGO_URI in your .env or environment.');
  process.exit(1);
}

mongoose
  .connect(mongoUri)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error', err);
    process.exit(1);
  });

app.get('/', (_req, res) => {
  res.send('✅ Backend is live!');
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/tutors', tutorRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/slots', slotRoutes);
app.use('/api/recordings', sessionRecordingRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/recurring-sessions', recurringSessionsRoutes);
app.use('/api/users', userRoutes);

// Serve static files for profile pictures
app.use('/uploads', express.static('uploads'));

// NOTE: CORS already configured above via corsOptions; do not re-register here.
const port = Number(process.env.PORT) || 4000;
// default to IPv4 loopback to avoid IPv6-only binding on some Windows setups
// default to 0.0.0.0 for deployments; set BIND_HOST=127.0.0.1 locally if you need IPv4 loopback only
const bindHost = process.env.BIND_HOST || '0.0.0.0';

// create an HTTP server and attach Socket.IO to it
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: {
    origin: allowAll ? true : allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  }
});
// store io instance for use in controllers
setIo(io);

// accept socket connections and map authenticated sockets into per-user rooms
try {
  io.on('connection', async (socket: any) => {
    try {
      const token = (socket.handshake && (socket.handshake.auth && socket.handshake.auth.token)) || (socket.handshake && socket.handshake.headers && socket.handshake.headers.authorization && String(socket.handshake.headers.authorization).startsWith('Bearer ') ? String(socket.handshake.headers.authorization).slice(7) : null) || null;
      let userId: string | null = null;
      if (token) {
        try {
          const secret = process.env.JWT_SECRET || 'dev_secret';
          const payload: any = jwt.verify(token, secret);
          userId = payload?.userId || null;
        } catch (e) {
          // ignore invalid token
          userId = null;
        }
      }
      if (userId) {
        try { socket.join(`user:${userId}`); } catch (e) {}
      }

      socket.on('disconnect', () => {
        // no-op for now
      });
    } catch (e) {
      // swallow per-connection errors
      console.error('socket connection handler error', e);
    }
  });
} catch (e) {
  console.error('failed to install socket connection handler', e);
}

httpServer.listen(port, bindHost, () => {
  console.log(`Server running on http://${bindHost}:${port}`);
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    const addrs: string[] = [];
    Object.values(ifaces).forEach((list: any) => {
      if (!list) return;
      list.forEach((i: any) => { if (i && i.address) addrs.push(i.address); });
    });
    console.log('Available network addresses:', Array.from(new Set(addrs)).join(', '));
  } catch (e) {}
});

// Background worker: expire past available slots every minute
try {
  const { Slot } = require('./models/Slot');
  setInterval(async () => {
    try {
      const now = new Date();
      await Slot.updateMany({ endAt: { $lt: now }, status: { $in: ['available','disabled'] } }, { $set: { status: 'expired' } });
    } catch (e) { /* ignore */ }
  }, 60 * 1000);
} catch (e) {}


