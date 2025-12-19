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

  if(!token){
    return res.status(401).send({message: 'unauthorized access'})
  }
  try{
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    req.decoded_email = decoded.email
    console.log('decoded in the token' , decoded)
    next();
  }
  catch(err){
    return res.status(404).send({message: "unauthorized access"})
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


// user related api
app.post('/users', async (req, res) => {
  const user = req.body;

  // optional safety check
  const existingUser = await userCollection.findOne({ email: user.email });
  if (existingUser) {
    return res.send({ message: "user already exists" });
  }

  user.createdAt = new Date();
  const result = await userCollection.insertOne(user);
  res.send(result);
});


// product api
// product api
app.get('/products', async (req, res) => {
  const query = {};
  const {email} = req.query;
  if(email) {
    query.senderEmail = email;
  }

  const options  = {sort: {createdAt: -1}}

  const result = await productCollection.find(query , options).toArray();
  res.send(result)
})

app.get('/products/:id' , async(req , res) => {
  const id = req.params.id;
  const query = {_id: new ObjectId(id)}
  const result = await productCollection.findOne(query)
  res.send(result)
})

app.post('/products', async (req, res) => {
  const product = req.body
  const result = await productCollection.insertOne(product)
  res.send(result)
})



app.delete('/products/:id' , async(req , res) => {
  const id = req.params.id;
  const query = {_id: new ObjectId(id)};
  const result = await productCollection.deleteOne(query)
  res.send(result)
})

// payment api

app.post('/create-checkout-session', async (req, res) => {
  try {
    const paymentInfo = req.body;

    const amount = parseInt(paymentInfo.cost) * 100;

    const session = await stripe.checkout.sessions.create({
      // payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amount,
            product_data: {
              name: paymentInfo.productName,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: paymentInfo.senderEmail,
      mode: 'payment',
      metadata: {
        productId: paymentInfo.productId,
        productName: paymentInfo.parcelName
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  } catch (error) {
   
    res.status(500).send({ error: 'Payment session failed' });
  }
});

app.patch('/payment-success' , async(req , res) => {
  const sessionId = req.query.session_id;

  const session = await stripe.checkout.sessions.retrieve(sessionId)
  // console.log("session retrieve" , session)

  const transactionId = session.payment_intent;
  const query = {transactionId: transactionId}

  const paymentExist = await paymentCollection.findOne(query)
  // console.log(paymentExist)

  if(paymentExist){
    return res.send({message: "already exists" ,
       transactionId ,
       trackingId: paymentExist.trackingId,
      
      })
  }

  const trackingId = generateTrackingId();

  if(session.payment_status === 'paid'){
    const id = session.metadata.productId;
    const query = {_id: new ObjectId(id)}
    const update = {
      $set: {
        paymentStatus: "paid",
        trackingId: trackingId,

      }
    }
    const result = await productCollection.updateOne(query , update)

    const paymentHistory = {
      amount: session.amount_total/100,
      currency: session.currency,
      customerEmail: session.customer_email,
      productId: session.metadata.productId,
      productName: session.metadata.parcelName,
      transactionId: session.payment_intent,
      paymentStatus: session.payment_status,
      paidAt: new Date(),
      trackingId: trackingId,
      

    }
    
    if(session.payment_status === 'paid'){
      const resultPayment = await paymentCollection.insertOne(paymentHistory)
      res.send({success: true ,
         modifyParcel: result ,
         trackingId: trackingId,
         transactionId: session.payment_intent,
          paymentInfo: resultPayment
        })
    }
    
  }

  res.send({success: false})
})

app.get('/payments' , verifyFBToken , async(req , res) => {
  const email = req.query.email;
  const query = {}

  


  if(email){
    query.customerEmail = email
    if(email !== req.decoded_email){
      return res.status(403).send({message: 'forbidden access'})
    }
  }
  const cursor = paymentCollection.find(query).sort({paidAt: -1})
  const result = await cursor.toArray()
  res.send(result)
})


// delivery related api 

app.get('/delivery' , async (req , res) => {
  const query = { }
  if(req.query.status){
    query.status = req.query.status
  }
  const cursor = deliveryCollection.find(query)
  const result = await cursor.toArray()
  res.send(result)
})

app.post('/delivery' , async (req ,res) => {
  const rider = req.body;
  rider.status = 'pending'
  rider.createdAt = new Date()

  const result = await deliveryCollection.insertOne(rider)
  res.send(result)
})

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
