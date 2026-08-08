const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const jwt = require('jsonwebtoken')
const port = process.env.PORT || 3000;

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

// Firebase Admin
const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FIREBASE_PRIVATE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(
  cors({
    origin: [process.env.SITE_DOMAIN,'https://garments-order.web.app'],
    credentials: true,
  })
);

// ------------------- MIDDLEWARE -------------------
const verifyFBToken = async (req, res, next) => {
  console.log(req.body)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    
    req.user = decoded;
    next();
  } catch (err) {
    console.error("verifyFBToken error:", err);
    return res.status(401).send({ message: "Unauthorized access" });
  }
};
// ---------------- MONGODB ----------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xalxakh.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("Premium_Garments");

    const productCollection = db.collection("products");
    const userCollection = db.collection("users");
    const orderCollection = db.collection("orders");

    console.log("MongoDB Connected");

    // ---------------- ROLE MIDDLEWARE ----------------
   const verifyManager = async (req, res, next) => {
  try {
    if (!req.user?.email) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const user = await userCollection.findOne({ email: req.user.email });
    if (!user || user.role !== "manager") {
      return res.status(403).send({ message: "Forbidden access" });
    }
    next();
  } catch (err) {
    console.error("verifyManager error:", err);
    return res.status(500).send({ message: "Server error", error: err.message });
  }
};

const verifyAdmin = async (req, res, next) => {
  try {
    if (!req.user?.email) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const user = await userCollection.findOne({ email: req.user.email });

    if (!user || user.role !== "admin") {
      return res.status(403).send({ message: "Admins only" });
    }

    next();
  } catch (err) {
    console.error("verifyAdmin error:", err);
    res.status(500).send({ message: "Server error", error: err.message });
  }
};

app.post('/getToken' , (req , res) => {
  const loggedUser = req.body
  const token = jwt.sign(loggedUser , process.env.JWT_SECRET , {expiresIn: '1h'})
  res.send({token: token})
})




    // ---------------- USERS ----------------
    app.get("/users",  async (req, res) => {
      try {
        const users = await userCollection.find().toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch users", error: err });
      }
    });

    app.post("/users",  async (req, res) => {
      try {
        const { email, name, photoURL } = req.body;
        if (!email) return res.status(400).send({ message: "Email required" });

        const exists = await userCollection.findOne({ email });
        if (exists) return res.send({ message: "User already exists" });

        const result = await userCollection.insertOne({
          email,
          name,
          photoURL,
          role: "user",
          status: "active",
          createdAt: new Date(),
        });

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to create user", error: err });
      }
    });

    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      try {
        if (req.user.email !== req.params.email) {
          return res.status(403).send({ message: "Forbidden" });
        }
        console.log(req.user)

        const user = await userCollection.findOne({ email: req.params.email });
        if (!user) return res.status(404).send({ message: "User not found" });

        res.send({ role: user.role });
      } catch (err) {
        console.log(err)
        res.status(500).send({ message: "Failed to get user role", error: err });
      }
    });

    app.patch("/users/:id", verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const payload = req.body;

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: payload }
        );

        res.send(
          result.modifiedCount > 0
            ? { success: true, modifiedCount: result.modifiedCount }
            : { success: false, message: "No changes made" }
        );
      } catch (err) {
        res.status(500).send({ message: "Failed to update user", error: err });
      }
    });

  // ---------------- PRODUCTS ----------------
app.get("/products", async (req, res) => {
  try {
    const products = await productCollection.find().toArray();
    res.send(products);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch products", error: err });
  }
});
app.get("/admin/products", async (req, res) => {
  try {
    const products = await productCollection.find().toArray();
    res.status(200).json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch products" });
  }
});

// Optional: Get latest 6 products
app.get("/products/special", async (req, res) => {
  try {
    const specialProducts = await productCollection.find().limit(6).toArray();
    res.send(specialProducts);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch special products", error: err });
  }
});

// Manager-only routes
app.get("/products/manager", async (req, res) => {
  try {
    const products = await productCollection.find().toArray();
    res.send(products);
  } catch (err) {
    console.error("GET /products/manager error:", err);
    res.status(500).send({ message: "Failed to fetch products", error: err.message });
  }
});

// Get single product by ID
app.get("/products/:id" , async (req, res) => {
  try {
    const product = await productCollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!product) return res.status(404).send({ message: "Product not found" });
    res.send(product);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch product", error: err });
  }
});



app.post("/products", verifyFBToken, verifyManager, async (req, res) => {
  try {
    const result = await productCollection.insertOne(req.body);
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to create product", error: err });
  }
});

// GET pending orders
app.get("/orders/pending", verifyFBToken, verifyManager, async (req, res) => {
  try {
    // Optional: only return orders for the logged-in user
    const email = req.query.email; // frontend can pass ?email=user@example.com
    const filter = { status: "pending" };

    if (email) filter.email = email;

    const pendingOrders = await orderCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(pendingOrders);
  } catch (err) {
    console.error("Failed to fetch pending orders:", err);
    res.status(500).send({ message: "Failed to fetch pending orders", error: err });
  }
});
app.patch("/orders/approve/:id", verifyFBToken,verifyManager, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await orderCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Approved" } }
    );
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to approve order" });
  }
});
app.patch("/orders/reject/:id", verifyFBToken, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await orderCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "Rejected" } }
    );
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to reject order" });
  }
});

app.patch("/admin/products/:id",verifyFBToken, verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const updatedData = req.body;

  try {
    const result = await productCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Product not found" });
    }

    res.send({ modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to update product" });
  }
});
app.patch("/products/:id", verifyFBToken, verifyManager, async (req, res) => {
  try {
    const { id } = req.params;
    const update = req.body;
    const result = await productCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to update product", error: err });
  }
});

app.delete("/admin/products/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await productCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount > 0) {
      return res.json({ message: "Product deleted successfully" });
    } else {
      return res.status(404).json({ message: "Product not found" });
    }
  } catch (err) {
    console.error("DELETE /admin/products/:id error:", err);
    res.status(500).json({ message: "Failed to delete product" });
  }
});
app.delete("/products/:id", verifyFBToken, verifyManager, verifyAdmin, async (req, res) => {
  try {
    const result = await productCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to delete product", error: err });
  }
});
    // ---------------- ORDERS ----------------
    app.get("/orders", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        if (email !== req.user.email) return res.status(403).send({ message: "Forbidden" });

        const orders = await orderCollection.find({ email }).sort({ createdAt: -1 }).toArray();
        res.send(orders);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch orders", error: err });
      }
    });

    app.post("/orders", verifyFBToken, async (req, res) => {
      try {
        if (req.body.email !== req.user.email)
          return res.status(403).send({ message: "Forbidden" });

        const result = await orderCollection.insertOne({
          ...req.body,
          status: "pending",
          createdAt: new Date(),
          trackingHistory: [],
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to create order", error: err });
      }
    });

    app.get("/orders/all", verifyFBToken, async (req, res) => {
      try {
        const { status } = req.query;
        const query = status ? { status } : {};
        const orders = await orderCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(orders);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch orders", error: err });
      }
    });

    app.get("/orders/approved", verifyFBToken, async (req, res) => {
      try {
        const orders = await orderCollection.find({ status: "approved" }).sort({ createdAt: -1 }).toArray();
        res.send(orders);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch approved orders", error: err });
      }
    });

    app.get("/orders/:id", verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const order = await orderCollection.findOne({ _id: new ObjectId(id) });
        if (!order) return res.status(404).send({ message: "Order not found" });
        res.send(order);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch order", error: err });
      }
    });

    app.patch("/orders/:status/:id", verifyFBToken, async (req, res) => {
      try {
        const { status, id } = req.params;
        if (!["approved", "rejected"].includes(status))
          return res.status(400).send({ message: "Invalid status" });

        const result = await orderCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        if (result.modifiedCount === 0)
          return res.status(404).send({ message: "Order not found" });

        res.send({ message: `Order ${status} successfully` });
      } catch (err) {
        res.status(500).send({ message: "Failed to update order", error: err });
      }
    });

    app.post("/orders/tracking/:orderId", async (req, res) => {
      try {
        const { orderId } = req.params;
        const trackingData = req.body;

        const result = await orderCollection.updateOne(
          { _id: new ObjectId(orderId) },
          { $push: { trackingHistory: trackingData } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to add tracking info", error: err });
      }
    });

    app.get("/orders/tracking/:orderId", async (req, res) => {
      try {
        const { orderId } = req.params;
        const order = await orderCollection.findOne(
          { _id: new ObjectId(orderId) },
          { projection: { trackingHistory: 1 } }
        );
        res.send(order?.trackingHistory || []);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch tracking info", error: err });
      }
    });

    // ---------------- STRIPE ----------------
  app.post("/create-checkout-session", verifyFBToken, async (req, res) => {
  try {
    const data = req.body;

    if (!data?.totalPrice) {
      return res.status(400).send({ message: "Total price missing" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: data.name },
            unit_amount: Math.round(Number(data.totalPrice) * 100),
          },
          quantity: data.quantity || 1,
        },
      ],
      metadata: {
        orderId: data.orderId,
        productId: data.productId,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).send({ message: err.message });
  }
});

    app.get("/payment-success", verifyFBToken, async (req, res) => {
  try {
    const sessionId = req.query.session_id;

    if (!sessionId) {
      return res.status(400).send({ message: "Session ID missing" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).send({ message: "Payment not completed" });
    }

    res.send({
      transactionId: session.payment_intent,
      orderId: session.metadata.orderId,
      productTitle: session.metadata.productId,
      amount: session.amount_total / 100,
      customer: session.customer_email,
    });
  } catch (err) {
    console.error("Stripe verify error:", err);
    res.status(500).send({ message: "Payment verification failed" });
  }
});

  } finally {
    // Keep MongoDB connection alive
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Premium Garments API Running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
