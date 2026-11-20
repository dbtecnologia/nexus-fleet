import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { User, UserRole } from '@prisma/client';
import { config } from './config.js';

export type AccessClaims = { sub: string; tenantId: string; role: UserRole; email: string };

export function hashPassword(password: string) { return bcrypt.hash(password, 12); }
export function verifyPassword(password: string, hash: string) { return bcrypt.compare(password, hash); }

export function issueAccessToken(user: Pick<User, 'id' | 'tenantId' | 'role' | 'email'>) {
  return jwt.sign({ tenantId: user.tenantId, role: user.role, email: user.email }, config.JWT_SECRET, {
    subject: user.id,
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, config.JWT_SECRET) as AccessClaims;
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const value = req.header('authorization');
  if (!value?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_bearer_token' });
  try {
    const claims = verifyAccessToken(value.slice(7));
    req.user = { id: claims.sub, tenantId: claims.tenantId, role: claims.role, email: claims.email };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'insufficient_permissions' });
    next();
  };
}
