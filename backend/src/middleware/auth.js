import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;

export function signToken(userId) {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: '7d' });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
