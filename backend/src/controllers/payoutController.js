const ShopEarning = require("../models/ShopEarning");
const PartnerEarning = require("../models/PartnerEarning");
const Payout = require("../models/Payout");
const mongoose = require("mongoose");

// Helper: date parsing
function parseDate(dateStr, fallback) {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? fallback : d;
}

// GET /api/admin/earnings/shops?shop_id&from&to&settled=false
const getShopEarnings = async (req, res) => {
  try {
    const { shop_id, from, to, settled } = req.query;

    const filter = {};
    if (shop_id) filter.shop_id = shop_id;

    const fromDate = from ? parseDate(from, null) : null;
    const toDate = to ? parseDate(to, null) : null;

    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = fromDate;
      if (toDate) filter.createdAt.$lte = toDate;
    }

    if (settled === "true") filter.is_settled = true;
    if (settled === "false") filter.is_settled = false;

    const earnings = await ShopEarning.find(filter)
      .sort({ createdAt: -1 })
      .populate("shop_id", "name");

    const totalNet = earnings.reduce((sum, e) => sum + e.net_payable, 0);

    res.json({
      success: true,
      total_net_payable: Number(totalNet.toFixed(2)),
      count: earnings.length,
      earnings
    });
  } catch (err) {
    console.error("getShopEarnings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/admin/earnings/partners?dp_id&from&to&settled=false
const getPartnerEarnings = async (req, res) => {
  try {
    const { dp_id, from, to, settled } = req.query;

    const filter = {};
    if (dp_id) filter.delivery_partner_id = dp_id;

    const fromDate = from ? parseDate(from, null) : null;
    const toDate = to ? parseDate(to, null) : null;

    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = fromDate;
      if (toDate) filter.createdAt.$lte = toDate;
    }

    if (settled === "true") filter.is_settled = true;
    if (settled === "false") filter.is_settled = false;

    const earnings = await PartnerEarning.find(filter)
      .sort({ createdAt: -1 })
      .populate("delivery_partner_id");

    const total = earnings.reduce((sum, e) => sum + e.total_earning, 0);

    res.json({
      success: true,
      total_earnings: Number(total.toFixed(2)),
      count: earnings.length,
      earnings
    });
  } catch (err) {
    console.error("getPartnerEarnings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// POST /api/admin/payouts/create
// body: { entity_type: "SHOP"|"DELIVERY_PARTNER", entity_id, from, to }
const createPayout = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { entity_type, entity_id, from, to } = req.body;

    if (!entity_type || !entity_id || !from || !to) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (entity_type === "SHOP") {
      const earnings = await ShopEarning.find({
        shop_id: entity_id,
        is_settled: false,
        createdAt: { $gte: fromDate, $lte: toDate }
      }).session(session);

      if (earnings.length === 0) {
        return res.status(400).json({ message: "No unsettled earnings found" });
      }

      const total = earnings.reduce((sum, e) => sum + e.net_payable, 0);

      const payout = await Payout.create(
        [
          {
            entity_type,
            entity_id,
            from_date: fromDate,
            to_date: toDate,
            total_earnings: Number(total.toFixed(2)),
            total_orders: earnings.length
          }
        ],
        { session }
      );

      const payoutId = payout[0]._id;

      await ShopEarning.updateMany(
        { _id: { $in: earnings.map((e) => e._id) } },
        {
          $set: {
            is_settled: true,
            payout_id: payoutId,
            settled_at: new Date()
          }
        }
      );

      await session.commitTransaction();
      session.endSession();

      return res.status(201).json({ success: true, payout: payout[0] });
    }

    if (entity_type === "DELIVERY_PARTNER") {
      const earnings = await PartnerEarning.find({
        delivery_partner_id: entity_id,
        is_settled: false,
        createdAt: { $gte: fromDate, $lte: toDate }
      }).session(session);

      if (earnings.length === 0) {
        return res.status(400).json({ message: "No unsettled earnings found" });
      }

      const total = earnings.reduce((sum, e) => sum + e.total_earning, 0);

      const payout = await Payout.create(
        [
          {
            entity_type,
            entity_id,
            from_date: fromDate,
            to_date: toDate,
            total_earnings: Number(total.toFixed(2)),
            total_orders: earnings.length
          }
        ],
        { session }
      );

      const payoutId = payout[0]._id;

      await PartnerEarning.updateMany(
        { _id: { $in: earnings.map((e) => e._id) } },
        {
          $set: {
            is_settled: true,
            payout_id: payoutId,
            settled_at: new Date()
          }
        }
      );

      await session.commitTransaction();
      session.endSession();

      return res.status(201).json({ success: true, payout: payout[0] });
    }

    return res.status(400).json({ message: "Invalid entity_type" });
  } catch (err) {
    console.error("createPayout error:", err);
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/admin/payouts/:id
const getPayoutDetail = async (req, res) => {
  try {
    const { id } = req.params;

    const payout = await Payout.findById(id);

    if (!payout) {
      return res.status(404).json({ message: "Payout not found" });
    }

    // Pull the underlying earning records that were settled into this payout.
    const earnings =
      payout.entity_type === "SHOP"
        ? await ShopEarning.find({ payout_id: payout._id }).populate("shop_id", "name")
        : await PartnerEarning.find({ payout_id: payout._id }).populate("delivery_partner_id");

    res.json({ success: true, payout, earnings });
  } catch (err) {
    console.error("getPayoutDetail error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/admin/payouts?entity_type=&status=
const listPayouts = async (req, res) => {
  try {
    const { entity_type, status } = req.query;

    const filter = {};
    if (entity_type) filter.entity_type = entity_type;
    if (status) filter.status = status;

    const payouts = await Payout.find(filter).sort({ createdAt: -1 });

    res.json({ success: true, payouts });
  } catch (err) {
    console.error("listPayouts error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// PATCH /api/admin/payouts/:id/pay
// body: { payment_reference, notes }
const markPayoutPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_reference, notes } = req.body;

    const payout = await Payout.findById(id);

    if (!payout) {
      return res.status(404).json({ message: "Payout not found" });
    }

    payout.status = "PAID";
    payout.paid_at = new Date();
    payout.payment_reference = payment_reference;
    payout.notes = notes;

    await payout.save();

    res.json({ success: true, payout });
  } catch (err) {
    console.error("markPayoutPaid error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getShopEarnings,
  getPartnerEarnings,
  createPayout,
  listPayouts,
  getPayoutDetail,
  markPayoutPaid
};