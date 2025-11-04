import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';

export async function signUp(req: Request, res: Response) {
  const { email, password, firstName, surname } = req.body;
  if (!email || !password || !firstName || !surname) return res.status(400).json({ message: 'Missing fields' });
  const existing = await User.findOne({ email });
  if (existing) return res.status(409).json({ message: 'Email already in use' });
  const passwordHash = await bcrypt.hash(password, 10);
  const fullName = `${firstName} ${surname}`;
  const user = await User.create({ email, passwordHash, firstName, surname, fullName });
  return res.status(201).json({ 
    id: user.id, 
    email: user.email, 
    firstName: user.firstName,
    surname: user.surname,
    fullName: user.fullName, 
    isTutor: user.isTutor 
  });
}

export async function signIn(req: Request, res: Response) {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ message: 'Invalid credentials' });
  const secret = process.env.JWT_SECRET || 'dev_secret';
  const token = jwt.sign({ userId: user.id }, secret, { expiresIn: '7d' });
  return res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, isTutor: user.isTutor } });
}

export async function me(_req: Request, res: Response) {
  // In middleware we've already validated token and set userId
  return res.json({ ok: true });
}


