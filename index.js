const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const crypto = require('crypto');
const admin = require("firebase-admin");
const serviceAccount = require("../garments order production tracker system/garments-order-firebase-adminsdk.json");
const { workers } = require('cluster');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
function generateTrackingId(prefix = 'PROD') {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(express.json());
app.use(cors());


const verifyFBToken = async (req , res , next) => {
  // console.log("headers in the middleware" , req.headers.authorization)
  const token = req.headers.authorization;
  console.log(token)

  if(!token){
    return res.status(401).send({message: 'unauthorized access'})
  }
  try{
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    console.log(decoded)
    req.decoded_email = decoded.email
    console.log('decoded in the token' , decoded)
    next();
  }
  catch(err){
    console.log(err)
    return res.status(401).send({message: "unauthorized access"})
  }
  
}

app.get('/', (req, res) => {
  res.send('Hello World!')
})


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.sq5rgml.mongodb.net/?appName=Cluster0`;


const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
})

async function run() {
  try {
   
    await client.connect();
    
const db = client.db("Premium_Garments");
const productCollection = db.collection("products");
const userCollection = db.collection("users");
const paymentCollection = db.collection('payments')
const deliveryCollection = db.collection('delivery')
const orderCollection = db.collection('orders')
const ridersCollection = db.collection('rider')


// middle more with database access

const verifyAdmin = async (req, res, next) => {
  try {
    const email = req.decoded_email; 

    if (!email) {
      return res.status(401).send({ message: "unauthorized access" });
    }

    const user = await userCollection.findOne({ email });

    if (!user || user.role !== "admin") {
      return res.status(403).send({ message: "forbidden access" });
    }

    next();
  } catch (error) {
    console.error("verifyAdmin error:", error);
    res.status(500).send({ message: "server error" });
  }
};

// Get user role
app.get("/users/:email/role", async (req, res) => {
  try {
    const { email } = req.params;
    const db = client.db("Premium_Garments");
    const userCollection = db.collection("users");

    const user = await userCollection.findOne({ email });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send({ role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Server error" });
  }
});



// products api

app.get('/products', async (req, res) => {
  const query = {};
  const {email , deliveryStatus} = req.query;
  if(email) {
    query.senderEmail = email;
  }
  if(deliveryStatus){
    query.deliveryStatus = deliveryStatus
  }

  const options  = {sort: {createdAt: -1}}

  const result = await productCollection.find(query , options).toArray();
  res.send(result)
})

app.get("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // console.log(" Product ID received:", id);

    // ObjectId check
    if (!ObjectId.isValid(id)) {
      // console.log(" Invalid ObjectId");
      return res.status(400).send({ message: "Invalid product id" });
    }

    const product = await productCollection.findOne({
      _id: new ObjectId(id),
    });

    // console.log(" Product from DB:", product);

    if (!product) {
      // console.log(" Product not found in database");
      return res.status(404).send({ message: "Product not found" });
    }

    res.send(product);
  } catch (error) {
    // console.error(" Product fetch error:", error);
    res.status(500).send({ message: "Server error" });
  }
});



// Order api

app.get("/orders", verifyFBToken, async (req, res) => {
  const email = req.query.email;

  if (req.decoded_email !== email) {
    return res.status(403).send({ message: "Forbidden" });
  }

  const result = await orderCollection
    .find({ email })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});


app.post("/orders", verifyFBToken, async (req, res) => {
  try {
    const order = req.body;

    // Product find
    const product = await productCollection.findOne({
      _id: new ObjectId(order.productId),
    });

    if (!product) {
      return res.status(404).send({ message: "Product not found" });
    }

    // Quantity validation (field name matches DB)
    if (
      order.orderQuantity < product.minimumOrder ||
      order.orderQuantity > product.quantity // <-- quantity field from DB
    ) {
      return res.status(400).send({ message: "Invalid order quantity" });
    }

    // Optional: verify user email
    if (order.email !== req.decoded_email) {
      return res.status(403).send({ message: "Unauthorized order request" });
    }

    // Save order
    const result = await orderCollection.insertOne({
      ...order,
      status: "pending",
      createdAt: new Date(),
    });

    // Reduce product stock
    await productCollection.updateOne(
      { _id: product._id },
      { $inc: { quantity: -order.orderQuantity } } // <-- match DB field
    );

    res.send(result);
  } catch (error) {
    console.error("Order creation failed:", error); // <-- log error
    res.status(500).send({ message: "Order creation failed" });
  }
});
// Pending Orders (Manager)
app.get("/orders/pending", verifyFBToken, async (req, res) => {
  const orders = await orderCollection
    .find({ status: "pending" })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(orders);
});

// Approve Order
app.patch("/orders/:id/approve", verifyFBToken, async (req, res) => {
  const { id } = req.params;
  const result = await orderCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: "approved", approvedAt: new Date() } }
  );
  res.send(result);
});

// Reject Order
app.patch("/orders/:id/reject", verifyFBToken, async (req, res) => {
  const { id } = req.params;
  const result = await orderCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: "rejected" } }
  );
  res.send(result);
});

// Approved Orders
app.get("/orders/approved", verifyFBToken, async (req, res) => {
  const orders = await orderCollection
    .find({ status: "approved" })
    .sort({ approvedAt: -1 })
    .toArray();
  res.send(orders);
});

// Add Tracking
app.post("/orders/:id/tracking", verifyFBToken, async (req, res) => {
  const { id } = req.params;
  const trackingData = req.body; // { location, note, status, date }
  const result = await orderCollection.updateOne(
    { _id: new ObjectId(id) },
    { $push: { tracking: trackingData } }
  );
  res.send(result);
});

// Get single order with tracking
app.get("/orders/:id", verifyFBToken, async (req, res) => {
  const { id } = req.params;
  const order = await orderCollection.findOne({ _id: new ObjectId(id) });
  res.send(order);
});


// GET /admin/products
app.get("/admin/products", verifyFBToken, verifyAdmin, async (req, res) => {
  try {
    const products = await productCollection.find().sort({ createdAt: -1 }).toArray();
    res.send(products);
  } catch (error) {
    // console.error("Fetch products error:", error);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});

// PATCH /admin/products/:id
app.patch("/admin/products/:id", verifyFBToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const result = await productCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    res.send(result);
  } catch (error) {
    console.error("Update product error:", error);
    res.status(500).send({ message: "Product update failed" });
  }
});

// DELETE /admin/products/:id
app.delete("/admin/products/:id", verifyFBToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await productCollection.deleteOne({ _id: new ObjectId(id) });

    res.send(result);
  } catch (error) {
    console.error("Delete product error:", error);
    res.status(500).send({ message: "Product delete failed" });
  }
});











// user related api

// app.get('/users' , verifyFBToken , async (req , res) => {

//   const searchText = req.query.searchText
//   const query = {}
//   if(searchText){
//     // query.name = {$regex: searchText , $options: 'i'}
//     query.$or = [
//       {name: {$regex: searchText , $options: 'i'}},
//       {email: {$regex: searchText , $options: 'i'}}
//     ]
//   }
//   const cursor = userCollection.find(query).sort({createdAt: -1}).limit(10)
//   const result = await cursor.toArray()
//   res.send(result)
// })

// app.get('/users/:id' , async (req , res) => {

// })

// app.get('/users/:email/role' , async (req , res) => {
//   const email = req.params.email
//   const query = {email}
//   const user = await userCollection.findOne(query)
//   res.send({role: user?.role || 'user'})
// })


// app.post('/users', async (req, res) => {
//   const user = req.body;

//   // optional safety check
//   const existingUser = await userCollection.findOne({ email: user.email });
//   if (existingUser) {
//     return res.send({ message: "user already exists" });
//   }

//   user.createdAt = new Date();
//   const result = await userCollection.insertOne(user);
//   res.send(result);
// });

// app.patch('/users/:id/role' , verifyFBToken , verifyAdmin , async (req , res) => {
//   const id = req.params.id;
//   const rolInfo = req.body
//   const query = {_id: new ObjectId(id)}
//   const updateDoc = {
//     $set: {
//       role: rolInfo.role
//     }
//   }
//   const result = await userCollection.updateOne(query , updateDoc)
//   res.send(result)
// })


// product api
// product api


// app.get('/products/:id' , async(req , res) => {
//   const id = req.params.id;
//   const query = {_id: new ObjectId(id)}
//   const result = await productCollection.findOne(query)
//   res.send(result)
// })

// app.post('/products', async (req, res) => {
//   const product = req.body
//   const result = await productCollection.insertOne(product)
//   res.send(result)
// })

// app.patch('/products/:id/rider', async (req, res) => {
//   const { riderId, riderName, riderEmail } = req.body;
//   const productId = req.params.id;

//   const productQuery = { _id: new ObjectId(productId) };
//   const productUpdate = {
//     $set: {
//       deliveryStatus: "driver_assigned",
//       riderId,
//       riderName,
//       riderEmail,
//     },
//   };

//   const productResult = await ridersCollection.updateOne(
//     productQuery,
//     productUpdate
//   );

//   const riderQuery = { _id: new ObjectId(riderId) };
//   const riderUpdate = {
//     $set: {
//       workerStatus: "in_delivery",
//     },
//   };

//   const riderResult = await deliveryCollection.updateOne(
//     riderQuery,
//     riderUpdate
//   );

//   res.send({
//     productResult,
//     riderResult,
//   });
// });


// app.patch("/products/:id", async (req, res) => {
//   const id = req.params.id;
//   const updateDoc = {
//     $set: req.body,
//   };

//   const result = await productCollection.updateOne(
//     { _id: new ObjectId(id) },
//     updateDoc
//   );

//   res.send(result);
// });



// app.delete('/products/:id' , async(req , res) => {
//   const id = req.params.id;
//   const query = {_id: new ObjectId(id)};
//   const result = await productCollection.deleteOne(query)
//   res.send(result)
// })

// // payment api

// app.post('/create-checkout-session', async (req, res) => {
//   try {
//     const paymentInfo = req.body;

//     const amount = parseInt(paymentInfo.cost) * 100;

//     const session = await stripe.checkout.sessions.create({
//       // payment_method_types: ['card'],
//       line_items: [
//         {
//           price_data: {
//             currency: 'usd',
//             unit_amount: amount,
//             product_data: {
//               name: paymentInfo.productName,
//             },
//           },
//           quantity: 1,
//         },
//       ],
//       customer_email: paymentInfo.senderEmail,
//       mode: 'payment',
//       metadata: {
//         productId: paymentInfo.productId,
//         productName: paymentInfo.parcelName
//       },
//       success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
//       cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
//     });

//     res.send({ url: session.url });
//   } catch (error) {
   
//     res.status(500).send({ error: 'Payment session failed' });
//   }
// });

// app.patch('/payment-success' , async(req , res) => {
//   const sessionId = req.query.session_id;

//   const session = await stripe.checkout.sessions.retrieve(sessionId)
//   // console.log("session retrieve" , session)

//   const transactionId = session.payment_intent;
//   const query = {transactionId: transactionId}

//   const paymentExist = await paymentCollection.findOne(query)
//   // console.log(paymentExist)

//   if(paymentExist){
//     return res.send({message: "already exists" ,
//        transactionId ,
//        trackingId: paymentExist.trackingId,
      
//       })
//   }

//   const trackingId = generateTrackingId();

//   if(session.payment_status === 'paid'){
//     const id = session.metadata.productId;
//     const query = {_id: new ObjectId(id)}
//     const update = {
//       $set: {
//         paymentStatus: "paid",
//         deliveryStatus: 'pending-pickup',
//         trackingId: trackingId,

//       }
//     }
//     const result = await productCollection.updateOne(query , update)

//     const paymentHistory = {
//       amount: session.amount_total/100,
//       currency: session.currency,
//       customerEmail: session.customer_email,
//       productId: session.metadata.productId,
//       productName: session.metadata.parcelName,
//       transactionId: session.payment_intent,
//       paymentStatus: session.payment_status,
//       paidAt: new Date(),
//       trackingId: trackingId,
      

//     }
    
//     if(session.payment_status === 'paid'){
//       const resultPayment = await paymentCollection.insertOne(paymentHistory)
//       res.send({success: true ,
//          modifyParcel: result ,
//          trackingId: trackingId,
//          transactionId: session.payment_intent,
//           paymentInfo: resultPayment
//         })
//     }
    
//   }

//   res.send({success: false})
// })

// app.get('/payments' , verifyFBToken , async(req , res) => {
//   const email = req.query.email;
//   const query = {}

  


//   if(email){
//     query.customerEmail = email
//     if(email !== req.decoded_email){
//       return res.status(403).send({message: 'forbidden access'})
//     }
//   }
//   const cursor = paymentCollection.find(query).sort({paidAt: -1})
//   const result = await cursor.toArray()
//   res.send(result)
// })


// delivery related api 
// app.get("/delivery", async (req, res) => {
//   try {
//     const { status, district, workerStatus } = req.query;
//     const query = {};

//     if (status) query.status = status;
//     if (district) query.District = district;
//     if (workerStatus) query.workerStatus = workerStatus;

//     console.log("Query:", query);
//     const cursor = deliveryCollection.find(query);
//     const result = await cursor.toArray();
//     res.send(result);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send({ message: "Internal Server Error" });
//   }
// });
// app.patch('/delivery/:id' , async(req , res) => {
//   const {riderId , riderName , riderEmail} = req.body
//   const id = req.params.id
//   const query = {_id: new ObjectId(id)}

//   const updateDoc = {
//     $set: {
//       deliveryStatus: 'driver_assigned',
//       riderId:riderId,
//       riderName: riderName,
//       riderEmail: riderEmail
//     }
//   }
//   const result =await productCollection.updateOne(query , updateDoc)
//   const riderQuery = {_id: new ObjectId(riderId)}
//   const riderUpdateDoc = {
//     $set: {
//       workerStatus: 'in_delivery',

//     }
//   }
//   const riderResult = await ridersCollection.updateOne(riderQuery , riderUpdateDoc)

//   res.send(result , riderResult)
// })

// app.post("/delivery", async (req, res) => {
//   try {
//     const rider = req.body;
//     rider.status = "pending";
//     rider.createdAt = new Date();

//     const result = await deliveryCollection.insertOne(rider);
//     res.send(result);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send({ message: "Failed to add delivery" });
//   }
// });

// app.patch("/delivery/:id", verifyFBToken, verifyAdmin, async (req, res) => {
//   try {
//     const id = req.params.id;
//     const { status, email } = req.body;

//     if (!status) return res.status(400).send({ message: "Status required" });
//     if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });

//     // Update delivery status
//     const query = { _id: new ObjectId(id) };
//     const updatedDoc = {
//       $set: {
//         status: status,
//         workerStatus: "available",
//         updatedAt: new Date(),
//       },
//     };
//     const result = await deliveryCollection.updateOne(query, updatedDoc);

//     // If approved, update user role
//     let userResult = null;
//     if (status === "approved" && email) {
//       const userQuery = { email };
//       const updateUser = { $set: { role: "rider" } };
//       userResult = await userCollection.updateOne(userQuery, updateUser);
//     }

//     res.send({ deliveryUpdate: result, userUpdate: userResult });
//   } catch (err) {
//     console.error(err);
//     res.status(500).send({ message: "Internal Server Error", error: err.message });
//   }
// });
// app.delete("/delivery/:id", verifyFBToken, async (req, res) => {
//   try {
//     const id = req.params.id;
//     if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });

//     const result = await deliveryCollection.deleteOne({ _id: new ObjectId(id) });
//     res.send(result);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send({ message: "Failed to delete delivery" });
//   }
// });



    await client.db("Premium_Garments").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);



app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
