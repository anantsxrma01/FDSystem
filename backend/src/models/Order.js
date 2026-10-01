const mongoose = require("mongoose");

const ORDER_STATUSES = [
  "PLACED",
  "CONFIRMED",
  "PREPARING",
  "READY_FOR_PICKUP",
  "PENDING_ASSIGNMENT",
  "ASSIGNED",
  "PICKED",
  "DELIVERED",
  "CANCELLED"
];

const PAYMENT_STATUSES = ["PENDING", "SUCCESS", "FAILED", "REFUNDED"];

const orderItemSchema = new mongoose.Schema(
  {
    item_id: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    qty: { type: Number, required: true },
    is_veg: { type: Boolean },
    total_price: { type: Number, required: true }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    order_number: { type: String, unique: true },

    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    shop_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
      index: true
    },

    address_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
      required: true
    },

    items: [orderItemSchema],

    payment_mode: {
      type: String,
      enum: ["COD", "ONLINE"],
      default: "COD"
    },

    payment_status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "PENDING"
    },

    order_status: {
      type: String,
      enum: ORDER_STATUSES,
      default: "PLACED",
      index: true
    },

    sub_total: { type: Number, required: true },
    delivery_charge: { type: Number, required: true },
    total_amount: { type: Number, required: true },

    distance_km: { type: Number, default: 0 }, // shop ↔ user address distance

    cancellation_reason: { type: String },

    delivery_partner_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryPartner"
    },

        // Earnings breakdown
    shop_gross: { type: Number, default: 0 },         // = sub_total
    shop_net: { type: Number, default: 0 },           // = shop_gross - platform_commission
    platform_commission: { type: Number, default: 0 },// commission amount
    delivery_charge_platform: { type: Number, default: 0 },
    delivery_charge_partner: { type: Number, default: 0 },

    // earning flags
    shop_earning_created: { type: Boolean, default: false },
    partner_earning_created: { type: Boolean, default: false },

    timeline: {
      placed_at: { type: Date },
      confirmed_at: { type: Date },
      preparing_at: { type: Date },
      ready_at: { type: Date },
      assigned_at: { type: Date },
      picked_at: { type: Date },
      delivered_at: { type: Date },
      cancelled_at: { type: Date }
    }
  },
  { timestamps: true }
);

// Indexes for analytics
orderSchema.index({ createdAt: 1 });
orderSchema.index({ createdAt: 1, order_status: 1 }); // compound index
orderSchema.index({ delivery_partner_id: 1 });

module.exports = mongoose.model("Order", orderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
