const DeliveryPartner = require("../models/DeliveryPartner");
const User = require("../models/User");
const Order = require("../models/Order");

// GET /api/admin/delivery-partners?status=&is_online=
const getAllDeliveryPartners = async (req, res) => {
  try {
    const { status, is_online } = req.query;

    const query = {};

    if (status) {
      query.status = status;
    }

    if (is_online === "true") {
      query.is_online = true;
    } else if (is_online === "false") {
      query.is_online = false;
    }

    const partners = await DeliveryPartner.find(query)
      .populate("user_id", "phone name")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      partners
    });
  } catch (err) {
    console.error("getAllDeliveryPartners error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/admin/delivery-partners/:id
const getDeliveryPartnerDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const partner = await DeliveryPartner.findById(id)
      .populate("user_id", "phone name");

    if (!partner) {
      return res.status(404).json({ message: "Delivery partner not found" });
    }

    // Orders count & delivered info (simple stats)
    const totalDelivered = await Order.countDocuments({
      delivery_partner_id: partner._id,
      order_status: "DELIVERED"
    });

    const activeOrders = await Order.countDocuments({
      delivery_partner_id: partner._id,
      order_status: { $in: ["ASSIGNED", "PICKED"] }
    });

    res.json({
      success: true,
      partner,
      stats: {
        totalDelivered,
        activeOrders
      }
    });
  } catch (err) {
    console.error("getDeliveryPartnerDetails error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// PATCH /api/admin/delivery-partners/:id/status
// body: { status: "ACTIVE" | "INACTIVE" | "PENDING" | "BANNED" }
const updateDeliveryPartnerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = ["ACTIVE", "INACTIVE", "PENDING", "BANNED"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const partner = await DeliveryPartner.findById(id).populate("user_id", "role");

    if (!partner) {
      return res.status(404).json({ message: "Delivery partner not found" });
    }

    partner.status = status;

    // BANNED या INACTIVE होने पर force offline
    if (status === "BANNED" || status === "INACTIVE") {
      partner.is_online = false;
    }

    await partner.save();

    // Keep the partner's User record (role + approval gate) in sync with
    // this status change, same as the management-portal approval flow
    // does. Without this, a partner activated here still shows as
    // "PENDING" and stays blocked by the requireApproved middleware.
    if (partner.user_id) {
      if (status === "ACTIVE") {
        const userUpdate = { approvalStatus: "APPROVED" };
        if (partner.user_id.role !== "DELIVERY_PARTNER") {
          userUpdate.role = "DELIVERY_PARTNER";
        }
        await User.findByIdAndUpdate(partner.user_id._id, userUpdate);
      } else if (status === "BANNED") {
        await User.findByIdAndUpdate(partner.user_id._id, {
          approvalStatus: "REJECTED"
        });
      }
      // INACTIVE / PENDING are operational states, not approval decisions,
      // so approvalStatus is left untouched for those.
    }

    res.json({
      success: true,
      partner,
      message: `Delivery partner status updated to ${status}`
    });
  } catch (err) {
    console.error("updateDeliveryPartnerStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/admin/delivery-partners/:id/orders
// simple list of last N delivered orders
const getDeliveryPartnerOrders = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit || "20", 10);

    const partner = await DeliveryPartner.findById(id);
    if (!partner) {
      return res.status(404).json({ message: "Delivery partner not found" });
    }

    const orders = await Order.find({ delivery_partner_id: partner._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("shop_id", "name")
      .populate("address_id", "line1 city");

    res.json({
      success: true,
      orders
    });
  } catch (err) {
    console.error("getDeliveryPartnerOrders error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getAllDeliveryPartners,
  getDeliveryPartnerDetails,
  updateDeliveryPartnerStatus,
  getDeliveryPartnerOrders
};