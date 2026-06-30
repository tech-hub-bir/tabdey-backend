const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db');

async function register(req, res, next) {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'name, email, phone, and password are required' });
    }

    const existing = await prisma.users.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.users.create({
      data: { user_name: name, email, phone, password_hash: hash },
      select: { user_id: true, user_name: true, email: true, role: true },
    });

    const token = jwt.sign(
      { id: user.user_id.toString(), name: user.user_name, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: { id: user.user_id.toString(), name: user.user_name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, phone, password } = req.body;

    if ((!email && !phone) || !password) {
      return res.status(400).json({ success: false, message: 'phone (or email) and password are required' });
    }

    const user = phone
      ? await prisma.users.findFirst({ where: { phone } })
      : await prisma.users.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    let organizer_id = null;
    if (user.role === 'organizer') {
      const org = await prisma.event_organizers.findUnique({ where: { user_id: user.user_id } });
      organizer_id = org?.id || null;
    }

    const token = jwt.sign(
      { id: user.user_id.toString(), name: user.user_name, email: user.email, role: user.role, organizer_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.user_id.toString(), name: user.user_name, email: user.email, role: user.role, organizer_id },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login };
