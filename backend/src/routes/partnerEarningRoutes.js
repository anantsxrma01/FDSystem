// backend/src/routes/partnerEarningRoutes.js

const express = require("express");
const { auth, allowRoles } = require("../middleware/authMiddleware");
const {
  getMyEarnings,
  getAllPartnersEarningsSummary
} = require("../controllers/partnerEarningController");

const router = express.Router();

// GET /api/partner/earnings/me — the logged-in delivery partner's own earnings
router.get("/me", auth, allowRoles("DELIVERY_PARTNER"), getMyEarnings);

// GET /api/partner/earnings/all — OWNER/MANAGER view across all partners
router.get("/all", auth, allowRoles("OWNER", "MANAGER"), getAllPartnersEarningsSummary);

module.exports = router;