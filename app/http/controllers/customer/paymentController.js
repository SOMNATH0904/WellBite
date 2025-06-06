const Order= require('../../../models/orderModel');
const Razorpay= require('razorpay');
const PaymentDetail= require('../../../models/paymentDetailModel');
const { nanoid } = require("nanoid"); // generate unique payment recieptID
const crypto= require('crypto');
const moment= require('moment'); // This JS library is used to format date and time nicely
const User= require('../../../models/userModel');
const emailLib= require('../../../../email');

// Create an instance of Razorpay
const razorPayInstance = new Razorpay({
	key_id: process.env.RAZORPAY_KEY_ID,
	key_secret: process.env.RAZORPAY_KEY_SECRET
});



// create user's Order --> Checkout page
exports.createOrder= async(req, res) => {
    
    // This can access user info from req.user
    // This can access session info from req.session
    // Order address and phoneNumber are in req.body
    const phone= req.body.phoneNumber;
    const address= req.body.address;
    const amount= parseInt(req.body.amount, 10);
    const orderMethod= req.body.orderMethod;

    console.log(phone, address, amount, orderMethod);

    if(orderMethod === 'online'){
        try{
        
            if(!phone || !address){
                throw new Error('Phone or Address are required');
            }
    
            const customerID= req.user._id;

            // step1: Generate razorpay order
            const params= {
                amount: amount * 100, // in paisa
                currency: "INR",
                receipt: nanoid(), // generate unique receiptID
                payment_capture: "1"
            }

            const resp= await razorPayInstance.orders.create(params);
            const razorpayKeyID = process.env.RAZORPAY_KEY_ID;
    
            // Step2: Save orderId and other payment details IN db
            const newOnlinePayment = await PaymentDetail.create({
                orderID: resp.id, // generated by razorpay
                receiptID: resp.receipt,
                customerID: customerID,
                amount: resp.amount,
                currency: resp.currency,
                createdAt: resp.created_at,
                status: resp.status
    
                // Now we are left with 'paymentID' (will be updated during payment), 'signature' (will be updated during payment-conformation) and 'productOrderID'
            });
            
    
            res.status(200).render('payment/checkout', {
                title: "Confirm Order",
                razorpayKeyID: razorpayKeyID,
                paymentDetail : newOnlinePayment,

                // Info to create order on payment success
                _phone: phone,
                _address: address,
                _customerID: req.user._id,
                _cart_items: req.session.cart.items
            });
            
        } catch (err) {
            console.log("Here 83");
            res.status(400).render('payment/fail',{
                title: "Payment checkout failed"
            });
        }
    }

    else{
        try{
            const phone= req.body.phoneNumber;
            const address= req.body.address;
    
            if(!phone || !address){
                throw new Error('Phone or Address are required');
            }
    
            const newOrder= await Order.create({
                customerID: req.user._id,
                items: req.session.cart.items,
                phone: phone,
                address: address,
                paymentType: orderMethod
            });
    
            // Emiting node-event after placing order (for socket io) to change adminOrder page in real time
            const eventEmitter = req.app.get('eventEmitterKey');
            eventEmitter.emit('oderPlaced');
            // we can listen to this event on server with name 'oderPlaced' and follwing data (2nd Arg)
    
            // as order is placed, so delete existing cart
            delete req.session.cart;

            // new order mail will be sent to user.
            await new emailLib(req.user, '').sendNewOrderMail();
    
            let query= Order.find({ customerID: req.user._id });
            query= query.sort('-createdAt');
            const orders= await query;

            res.status(200).render('customers/order', {
                orders: orders ,
                moment: moment // we are sending whole library to front-end 😂 (in order to format dates)
            });
        } catch (err) {
            res.status(404).render('error', {
                message: "Can't place order :("
            });
        }
    }

    
}


exports.verifyPayment= async(req, res) => {

    try{
        const body= req.body.razorpay_order_id + "|" + req.body.razorpay_payment_id;
        let expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body.toString()).digest('hex');

        // Compare the signatures
        if(expectedSignature === req.body.razorpay_signature) {

            // Now create actual order
            const customerID= req.body.order_customer_id;
            const items= JSON.parse(req.body.order_cart_items);
            const phone= req.body.order_phone;
            const address= req.body.order_address;

            const newOrder= await Order.create({
                customerID: customerID,
                items: items,
                phone: phone,
                address: address,
                paymentType: "online"
            });

            // as order is placed, so delete existing cart
            delete req.session.cart;

            // new order mail will be sent to user.
            const myUser= await User.findOne({_id: customerID});
            await new emailLib(myUser, '').sendNewOrderMail();

            const productOrderID= newOrder._id;

            // if same, then find the previosuly stored record using orderId and update paymentId and signature, and set status to paid. 
            const updatedDoc= await PaymentDetail.findOneAndUpdate({ orderID: req.body.razorpay_order_id }, {
                    paymentID: req.body.razorpay_payment_id,
                    signature: req.body.razorpay_signature,
                    productOrderID: productOrderID,
                    status: "paid"
                },
                { 
                    new: true,
                    runValidators: false
                }
            );
            
            if(updatedDoc){

                // Emiting node-event after placing order (for socket io) to change adminOrder page in real time
                const eventEmitter = req.app.get('eventEmitterKey');
                eventEmitter.emit('oderPlaced');
                // we can listen to this event on server with name 'oderPlaced' and follwing data (2nd Arg)

                res.status(200).render('payment/success', {
                    title: "Payment verification successful",
                    paymentDetail: updatedDoc,
                    moment: moment
                });
            }
        } else {
            res.status(404).render('payment/fail', {
                title: "Payment verification failed",
            });
        }
    } catch (err){
        res.status(404).render('payment/fail', {
            title: "Payment verification failed",
        });
    }
}