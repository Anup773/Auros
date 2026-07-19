'use strict';
/**
 * backend/routes/admin.routes.js
 *
 * PHASE 2 — "Advanced RBAC (admin manages user roles)".
 * Every route here requires both a valid session AND the admin role.
 */

const express    = require('express');
const router     = express.Router();
const authCtrl   = require('../controllers/auth.controller');
const adminCtrl  = require('../controllers/admin.controller');
const { requireAdmin } = require('../middleware/rbac');
const { validate, schemas } = require('../middleware/validate');

router.use(authCtrl.requireAuth, requireAdmin);

router.get   ('/users',              adminCtrl.listUsers);
router.patch ('/users/:id/role',     validate(schemas.updateUserRole), adminCtrl.updateUserRole);
router.post  ('/users/:id/disable',  adminCtrl.disableUser);
router.post  ('/users/:id/enable',   adminCtrl.enableUser);
router.get   ('/security-log',       adminCtrl.getSecurityLog);

module.exports = router;