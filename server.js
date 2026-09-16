const express=require("express");
const session=require("express-session");
const bcrypt=require("bcrypt");
const {Pool}=require("pg");
const path=require("path");
const crypto=require("crypto");
require("dotenv").config();
const app=express();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
app.use(express.json());
app.use(session({secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:false}}));
app.use(express.static(path.join(__dirname)));

app.post("/api/register",async(req,res)=>{
 try{const {email,password}=req.body;if(!email||!password||password.length<8)return res.status(400).json({error:"Нужны e-mail и пароль минимум 8 символов"});
 const hash=await bcrypt.hash(password,12);const r=await pool.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email",[email.toLowerCase(),hash]);req.session.userId=r.rows[0].id;res.json({user:r.rows[0]});
 }catch(e){res.status(400).json({error:e.code==="23505"?"Пользователь уже существует":"Ошибка регистрации"})}
});
app.post("/api/login",async(req,res)=>{
 const r=await pool.query("SELECT id,email,is_admin,password_hash FROM users WHERE email=$1",[String(req.body.email||"").toLowerCase()]);
 if(!r.rowCount||!(await bcrypt.compare(req.body.password||"",r.rows[0].password_hash)))return res.status(401).json({error:"Неверный e-mail или пароль"});
 req.session.userId=r.rows[0].id;res.json({id:r.rows[0].id,email:r.rows[0].email,isAdmin:r.rows[0].is_admin});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",async(req,res)=>{if(!req.session.userId)return res.json({user:null});const r=await pool.query("SELECT id,email,is_admin FROM users WHERE id=$1",[req.session.userId]);res.json({user:r.rows[0]||null})});
app.get("/api/programs",async(req,res)=>{const r=await pool.query("SELECT id,title,category,description,price_pln,weeks FROM programs ORDER BY id DESC");res.json(r.rows)});
function admin(req,res,next){if(!req.session.userId)return res.status(401).json({error:"Требуется вход"});pool.query("SELECT is_admin FROM users WHERE id=$1",[req.session.userId]).then(r=>r.rowCount&&r.rows[0].is_admin?next():res.status(403).json({error:"Нет доступа"})).catch(()=>res.status(500).json({error:"Ошибка"}))}
app.post("/api/admin/programs",admin,async(req,res)=>{const {title,category,description,price,weeks}=req.body;if(!title||!category||isNaN(price))return res.status(400).json({error:"Заполни название, категорию и цену"});const r=await pool.query("INSERT INTO programs(title,category,description,price_pln,weeks) VALUES($1,$2,$3,$4,$5) RETURNING *",[title,category,description||"",price,weeks||null]);res.json(r.rows[0])});
app.delete("/api/admin/programs/:id",admin,async(req,res)=>{await pool.query("DELETE FROM programs WHERE id=$1",[req.params.id]);res.json({ok:true})});

// PayU Sandbox
async function payuToken(){
 const base=process.env.PAYU_BASE_URL||"https://secure.snd.payu.com";
 const body=new URLSearchParams({grant_type:"client_credentials",client_id:process.env.PAYU_CLIENT_ID||"",client_secret:process.env.PAYU_CLIENT_SECRET||""});
 const r=await fetch(base+"/pl/standard/user/oauth/authorize",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
 if(!r.ok) throw new Error("PayU OAuth failed");
 return (await r.json()).access_token;
}
app.post("/api/payu/create-order",async(req,res)=>{
 try{
  if(!req.session.userId)return res.status(401).json({error:"Сначала войдите"});
  const {programId}=req.body;
  const pr=await pool.query("SELECT id,title,price_pln FROM programs WHERE id=$1",[programId]);
  if(!pr.rowCount)return res.status(404).json({error:"Программа не найдена"});
  const p=pr.rows[0], ext="BG"+Date.now()+crypto.randomBytes(4).toString("hex");
  const token=await payuToken(), base=process.env.PAYU_BASE_URL||"https://secure.snd.payu.com";
  const amount=Math.round(Number(p.price_pln)*100);
  const order={notifyUrl:process.env.PAYU_NOTIFY_URL,continueUrl:process.env.PAYU_CONTINUE_URL,customerIp:req.ip,merchantPosId:process.env.PAYU_POS_ID,description:"Bizon GYM - "+p.title,currencyCode:"PLN",totalAmount:String(amount),extOrderId:ext,products:[{name:p.title,unitPrice:String(amount),quantity:"1"}]};
  const r=await fetch(base+"/api/v2_1/orders",{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(order)});
  const text=await r.text(); let data; try{data=JSON.parse(text)}catch{data={raw:text}};
  if(r.status!==200 && r.status!==201 && r.status!==302)return res.status(502).json({error:"PayU не принял заказ",details:data});
  const redirect=data.redirectUri;
  await pool.query("INSERT INTO orders(user_id,status,total_pln,ext_order_id,program_id) VALUES($1,$2,$3,$4,$5)",[req.session.userId,"PENDING",p.price_pln,ext,p.id]);
  res.json({redirectUri:redirect,orderId:data.orderId});
 }catch(e){console.error(e);res.status(500).json({error:e.message})}
});
app.post("/api/payu/notify",async(req,res)=>{
 try{
  const o=req.body?.order;if(!o)return res.sendStatus(200);
  await pool.query("UPDATE orders SET status=$1,payu_order_id=$2 WHERE ext_order_id=$3",[o.status,o.orderId,o.extOrderId]);
  // Доступ выдаём только после COMPLETED, а не по redirect пользователя.
  if(o.status==="COMPLETED") await pool.query("INSERT INTO entitlements(user_id,program_id,order_id) SELECT user_id,program_id,id FROM orders WHERE ext_order_id=$1 ON CONFLICT DO NOTHING",[o.extOrderId]);
  res.sendStatus(200);
 }catch(e){console.error(e);res.sendStatus(500)}
});

app.listen(process.env.PORT||3000,()=>console.log("Bizon GYM server started"));
