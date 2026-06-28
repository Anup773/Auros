'use strict';
/**
 * backend/routes/auth.routes.js — Security Hardened
 *
 * Added: POST /logout endpoint
 * Note: validate() and authLimiter are applied in app.js before this router,
 * so no need to add them again here.
 */

const express  = require('express');
const router   = express.Router();
const authCtrl = require('../controllers/auth.controller');

router.post('/signup', authCtrl.signup);
router.post('/login',  authCtrl.login);
router.post('/google', authCtrl.googleAuth);
router.get ('/me',     authCtrl.requireAuth, authCtrl.getMe);
router.post('/logout', authCtrl.requireAuth, authCtrl.logout);

module.exports = router;