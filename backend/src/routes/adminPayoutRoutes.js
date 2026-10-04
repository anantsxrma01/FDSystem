// backend/src/routes/adminPayoutRoutes.js

const express = require("express");
const { auth, allowRoles } = require("../middleware/authMiddleware");
const {
  getShopEarnings,
  getPartnerEarnings,
  createPayout,
  listPayouts,
  getPayoutDetail,
  markPayoutPaid
} = require("../controllers/payoutController");

const router = express.Router();

// Sirf OWNER / MANAGER ko access
router.use(auth, allowRoles("OWNER", "MANAGER"));

// Earnings views (what's owed, before creating a payout) — must come
// before "/:id" so these literal paths aren't shadowed.
router.get("/earnings/shops", getShopEarnings);
router.get("/earnings/partners", getPartnerEarnings);

// Create a payout from unsettled earnings in a date range
router.post("/create", createPayout);

// List payouts
router.get("/", listPayouts);

// Payout detail
router.get("/:id", getPayoutDetail);

// Mark payout as paid
router.patch("/:id/mark-paid", markPayoutPaid);

module.exports = router;