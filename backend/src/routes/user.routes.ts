import { Router } from 'express';
import { getUserProfile, updateUserProfile } from '../controllers/user.controller';
import { requireAuth } from '../middleware/auth.middleware';

export const router = Router();

router.get('/:userId', requireAuth, getUserProfile);
router.put('/:userId', requireAuth, updateUserProfile);
// Profile picture upload endpoint removed.
