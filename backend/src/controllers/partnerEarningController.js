// backend/src/controllers/partnerEarningController.js
//
// Reads from the PartnerEarning collection, which is the single source of
// truth for delivery-partner earnings (created in deliveryPartnerController's
// markOrderDelivered via utils/earningHelpers + config/financeConfig). This
// controller used to recompute earnings itself with a different, unused
// formula — that has been removed so every part of the app agrees on one
// number per order.

const DeliveryPartner = require("../models/DeliveryPartner");
const PartnerEarning = require("../models/PartnerEarning");

/**
 * GET /api/partner/earnings/me
 * Role: DELIVERY_PARTNER
 * Returns summary + list of this partner's recorded earnings.
 */
const getMyEarnings = async (req, res) => {
  try {
    const userId = req.user.id;

    const partner = await DeliveryPartner.findOne({ user_id: userId });

    if (!partner) {
      return res.status(404).json({ message: "Delivery partner profile not found" });
    }

    const earnings = await PartnerEarning.find({ delivery_partner_id: partner._id })
      .sort({ createdAt: -1 })
      .populate("order_id", "order_number createdAt total_amount");

    const totalEarning = earnings.reduce((sum, e) => sum + e.total_earning, 0);
    const totalUnsettled = earnings
      .filter((e) => !e.is_settled)
      .reduce((sum, e) => sum + e.total_earning, 0);

    res.json({
      success: true,
      partner: {
        id: partner._id,
        total_trips: partner.total_trips,
        status: partner.status
      },
      summary: {
        total_earning: Number(totalEarning.toFixed(2)),
        total_unsettled: Number(totalUnsettled.toFixed(2)),
        total_delivered_orders: earnings.length
      },
      earnings
    });
  } catch (err) {
    console.error("getMyEarnings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * GET /api/partner/earnings/all
 * Role: OWNER / MANAGER
 * Returns earning summary per partner, aggregated from PartnerEarning.
 */
const getAllPartnersEarningsSummary = async (req, res) => {
  try {
    const earnings = await PartnerEarning.find({})
      .populate({
        path: "delivery_partner_id",
        select: "user_id status",
        populate: { path: "user_id", select: "name phone" }
      });

    const map = new Map();

    for (const e of earnings) {
      const partner = e.delivery_partner_id;
      if (!partner) continue;

      const partnerId = String(partner._id);

      if (!map.has(partnerId)) {
        map.set(partnerId, {
          partner_id: partnerId,
          user: partner.user_id,
          status: partner.status,
          total_earning: 0,
          total_unsettled: 0,
          total_orders: 0
        });
      }

      const entry = map.get(partnerId);
      entry.total_earning += e.total_earning;
      if (!e.is_settled) entry.total_unsettled += e.total_earning;
      entry.total_orders += 1;
    }

    const summary = Array.from(map.values()).map((entry) => ({
      ...entry,
      total_earning: Number(entry.total_earning.toFixed(2)),
      total_unsettled: Number(entry.total_unsettled.toFixed(2))
    }));

    res.json({
      success: true,
      count: summary.length,
      partners: summary
    });
  } catch (err) {
    console.error("getAllPartnersEarningsSummary error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getMyEarnings,
  getAllPartnersEarningsSummary
};