import 'dotenv/config';
import express, {Request, Response, NextFunction} from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import {Pool} from 'pg';
import {randomBytes, createHash} from 'node:crypto';
import {AccessToken} from 'livekit-server-sdk';
import {z} from 'zod';

const app=express();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const jwtSecret=process.env.JWT_SECRET || 'change-me';
app.use(cors({origin:process.env.CORS_ORIGIN==='*'?true:process.env.CORS_ORIGIN}));
app.use(express.json({limit:'1mb'}));
app.use('/auth',rateLimit({windowMs:60_000,max:20}));
type AuthRequest=Request & {userId?:string};
function auth(req:AuthRequest,res:Response,next:NextFunction){
  const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');
  if(!token)return res.status(401).json({error:'missing_token'});
  try{const p=jwt.verify(token,jwtSecret) as {sub:string};req.userId=p.sub;next();}
  catch{return res.status(401).json({error:'invalid_token'});}
}
function asyncRoute(fn:(req:AuthRequest,res:Response)=>Promise<unknown>){return (req:Request,res:Response,next:NextFunction)=>Promise.resolve(fn(req as AuthRequest,res)).catch(next);}
const oauthStates=new Map<string,number>();
app.get('/health',(_req,res)=>res.json({ok:true}));

// Instagram Login OAuth: state is short-lived and single-use; callback redirects only the app JWT.
app.get('/auth/instagram',(_req,res)=>{
  const {INSTAGRAM_APP_ID,INSTAGRAM_REDIRECT_URI}=process.env;
  if(!INSTAGRAM_APP_ID||!INSTAGRAM_REDIRECT_URI)return res.status(503).json({error:'instagram_oauth_not_configured'});
  const state=randomBytes(24).toString('hex'); oauthStates.set(state,Date.now()+10*60_000);
  const url=new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id',INSTAGRAM_APP_ID);url.searchParams.set('redirect_uri',INSTAGRAM_REDIRECT_URI);
  url.searchParams.set('response_type','code');url.searchParams.set('scope','instagram_business_basic');url.searchParams.set('state',state);
  res.json({authorizationUrl:url.toString(),state});
});
app.get('/auth/instagram/callback',asyncRoute(async(req,res)=>{
  const code=String(req.query.code||''),state=String(req.query.state||'');
  const expires=oauthStates.get(state);oauthStates.delete(state);
  if(!expires||expires<Date.now()||!code)return res.status(400).send('OAuth state/code invalid or expired. Return to KRMEET and try again.');
  const form=new URLSearchParams({client_id:process.env.INSTAGRAM_APP_ID||'',client_secret:process.env.INSTAGRAM_APP_SECRET||'',grant_type:'authorization_code',redirect_uri:process.env.INSTAGRAM_REDIRECT_URI||'',code});
  const tokenResponse=await fetch('https://api.instagram.com/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});
  const tokenData=await tokenResponse.json() as {access_token?:string,user_id?:string,error_message?:string};
  if(!tokenResponse.ok||!tokenData.access_token||!tokenData.user_id)return res.status(401).send('Instagram token exchange failed.');
  const profileResponse=await fetch(`https://graph.instagram.com/me?fields=user_id,username,profile_picture_url&access_token=${encodeURIComponent(tokenData.access_token)}`);
  const profile=await profileResponse.json() as {user_id?:string;id?:string;username?:string;profile_picture_url?:string};
  if(!profileResponse.ok||!profile.username)return res.status(401).send('Could not read Instagram profile.');
  const igId=String(profile.user_id||profile.id||tokenData.user_id);
  const result=await pool.query('INSERT INTO users(instagram_id,username,profile_picture_url) VALUES($1,$2,$3) ON CONFLICT(instagram_id) DO UPDATE SET username=EXCLUDED.username,profile_picture_url=EXCLUDED.profile_picture_url,updated_at=now() RETURNING id,username,profile_picture_url',[igId,profile.username,profile.profile_picture_url||null]);
  const appToken=jwt.sign({sub:result.rows[0].id},jwtSecret,{expiresIn:'7d'});
  const deepLink=new URL(process.env.APP_DEEP_LINK||'krmeet://auth');deepLink.searchParams.set('token',appToken);
  res.redirect(deepLink.toString());
}));
app.get('/me',auth,asyncRoute(async(req,res)=>{const q=await pool.query('SELECT id,username,profile_picture_url FROM users WHERE id=$1',[req.userId]);res.json(q.rows[0]||null);}));
app.get('/me/vehicles',auth,asyncRoute(async(req,res)=>{const q=await pool.query('SELECT id,make,model,year,modifications,photos,is_public FROM vehicles WHERE user_id=$1 ORDER BY created_at DESC',[req.userId]);res.json(q.rows);}));
app.post('/me/vehicles',auth,asyncRoute(async(req,res)=>{const b=z.object({make:z.string().min(1).max(80),model:z.string().min(1).max(100),year:z.number().int().min(1886).max(2100).optional(),modifications:z.string().max(3000).optional(),photos:z.array(z.string().url()).max(12).optional(),isPublic:z.boolean().optional()}).parse(req.body);const q=await pool.query('INSERT INTO vehicles(user_id,make,model,year,modifications,photos,is_public) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,make,model,year,modifications,photos,is_public',[req.userId,b.make,b.model,b.year||null,b.modifications||'',b.photos||[],b.isPublic||false]);res.status(201).json(q.rows[0]);}));

app.post('/groups',auth,asyncRoute(async(req,res)=>{
  const b=z.object({name:z.string().min(2).max(80),description:z.string().max(500).optional()}).parse(req.body);
  const c=await pool.connect();try{await c.query('BEGIN');const g=await c.query('INSERT INTO groups(name,description,created_by) VALUES($1,$2,$3) RETURNING *',[b.name,b.description||'',req.userId]);await c.query("INSERT INTO group_members(group_id,user_id,role,status,decided_at) VALUES($1,$2,'admin','approved',now())",[g.rows[0].id,req.userId]);await c.query('COMMIT');res.status(201).json(g.rows[0]);}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));
app.post('/groups/:id/invites',auth,asyncRoute(async(req,res)=>{
  const admin=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND role='admin' AND status='approved'",[req.params.id,req.userId]);if(!admin.rowCount)return res.status(403).json({error:'admin_required'});
  const raw=randomBytes(24).toString('base64url'),hash=createHash('sha256').update(raw).digest('hex');
  await pool.query('INSERT INTO group_invites(group_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,now()+interval \'7 days\')',[req.params.id,hash,req.userId]);res.status(201).json({inviteUrl:`krmeet://g/${req.params.id}?invite=${raw}`,expiresInDays:7});
}));
app.post('/groups/:id/join',auth,asyncRoute(async(req,res)=>{
  const token=String(req.body?.inviteToken||'');
  if(!token)return res.status(403).json({error:'invite_required'});
  const hash=createHash('sha256').update(token).digest('hex');const invite=await pool.query('SELECT 1 FROM group_invites WHERE group_id=$1 AND token_hash=$2 AND (expires_at IS NULL OR expires_at>now())',[req.params.id,hash]);if(!invite.rowCount)return res.status(403).json({error:'invalid_invite'});
  await pool.query("INSERT INTO group_members(group_id,user_id,status) VALUES($1,$2,'pending') ON CONFLICT(group_id,user_id) DO UPDATE SET status='pending',requested_at=now(),decided_at=NULL",[req.params.id,req.userId]);res.status(202).json({status:'pending'});
}));
app.get('/groups/:id/requests',auth,asyncRoute(async(req,res)=>{const a=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND role='admin' AND status='approved'",[req.params.id,req.userId]);if(!a.rowCount)return res.status(403).json({error:'admin_required'});const q=await pool.query("SELECT m.user_id,u.username,u.profile_picture_url,m.requested_at FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.status='pending' ORDER BY requested_at",[req.params.id]);res.json(q.rows);}));
app.post('/groups/:id/requests/:userId',auth,asyncRoute(async(req,res)=>{const a=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND role='admin' AND status='approved'",[req.params.id,req.userId]);if(!a.rowCount)return res.status(403).json({error:'admin_required'});const status=z.enum(['approved','rejected']).parse(req.body.status);const q=await pool.query("UPDATE group_members SET status=$1,decided_at=now() WHERE group_id=$2 AND user_id=$3 AND status='pending' RETURNING status",[status,req.params.id,req.params.userId]);if(!q.rowCount)return res.status(404).json({error:'request_not_found'});res.json(q.rows[0]);}));
app.get('/groups/:id/locations',auth,asyncRoute(async(req,res)=>{const m=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='approved'",[req.params.id,req.userId]);if(!m.rowCount)return res.status(403).json({error:'approved_member_required'});const q=await pool.query("SELECT l.user_id,u.username,ST_AsGeoJSON(l.point::geometry)::json->'coordinates' AS coordinates,l.updated_at FROM locations l JOIN users u ON u.id=l.user_id JOIN group_members m ON m.group_id=l.group_id AND m.user_id=l.user_id AND m.status='approved' WHERE l.group_id=$1 AND l.visible=true AND l.updated_at>now()-interval '2 minutes'",[req.params.id]);res.json(q.rows);}));
app.put('/groups/:id/location',auth,asyncRoute(async(req,res)=>{const b=z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),visible:z.boolean()}).parse(req.body);const m=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='approved'",[req.params.id,req.userId]);if(!m.rowCount)return res.status(403).json({error:'approved_member_required'});await pool.query('INSERT INTO locations(user_id,group_id,point,visible,updated_at) VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5,now()) ON CONFLICT(user_id,group_id) DO UPDATE SET point=EXCLUDED.point,visible=EXCLUDED.visible,updated_at=now()',[req.userId,req.params.id,b.longitude,b.latitude,b.visible]);res.status(204).end();}));
app.get('/events',auth,asyncRoute(async(req,res)=>{const lat=Number(req.query.lat),lng=Number(req.query.lng),radius=Math.min(Number(req.query.radius)||50000,200000);const q=await pool.query(`SELECT e.id,e.title,e.description,e.event_type,e.starts_at,e.ends_at,e.address,g.id group_id,g.name group_name,ST_Y(e.location::geometry) latitude,ST_X(e.location::geometry) longitude${Number.isFinite(lat)&&Number.isFinite(lng)?",ST_Distance(e.location,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) distance_m":""} FROM events e LEFT JOIN groups g ON g.id=e.group_id WHERE e.starts_at>=COALESCE($3::timestamptz,now()-interval '1 day') AND (e.group_id IS NULL OR EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=e.group_id AND m.user_id=$4 AND m.status='approved')) ${Number.isFinite(lat)&&Number.isFinite(lng)?'AND ST_DWithin(e.location,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$5)':''} ORDER BY e.starts_at LIMIT 100`,Number.isFinite(lat)&&Number.isFinite(lng)?[lng,lat,req.query.from||null,req.userId,radius]:[null,null,req.query.from||null,req.userId]);res.json(q.rows);}));
app.post('/events',auth,asyncRoute(async(req,res)=>{const b=z.object({title:z.string().min(2).max(120),description:z.string().max(2000).optional(),type:z.enum(['meet','track_day','rally','drag']),startsAt:z.string().datetime(),endsAt:z.string().datetime().optional(),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),address:z.string().max(300).optional(),groupId:z.string().uuid().optional()}).parse(req.body);if(b.groupId){const m=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='approved'",[b.groupId,req.userId]);if(!m.rowCount)return res.status(403).json({error:'approved_member_required'});}const q=await pool.query('INSERT INTO events(group_id,created_by,title,description,event_type,starts_at,ends_at,location,address) VALUES($1,$2,$3,$4,$5,$6,$7,ST_SetSRID(ST_MakePoint($8,$9),4326)::geography,$10) RETURNING id,title,event_type,starts_at,ends_at,address',[b.groupId||null,req.userId,b.title,b.description||'',b.type,b.startsAt,b.endsAt||null,b.longitude,b.latitude,b.address||null]);res.status(201).json(q.rows[0]);}));
app.post('/voice/token',auth,asyncRoute(async(req,res)=>{const b=z.object({groupId:z.string().uuid().optional(),peerUserId:z.string().uuid().optional()}).refine(x=>Boolean(x.groupId||x.peerUserId)).parse(req.body);let room:string;if(b.groupId){const m=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='approved'",[b.groupId,req.userId]);if(!m.rowCount)return res.status(403).json({error:'approved_member_required'});room=`group-${b.groupId}`;}else{const exists=await pool.query('SELECT 1 FROM users WHERE id=$1',[b.peerUserId]);if(!exists.rowCount)return res.status(404).json({error:'user_not_found'});room=`call-${[req.userId,b.peerUserId].sort().join('-')}`;}
  if(!process.env.LIVEKIT_API_KEY||!process.env.LIVEKIT_API_SECRET)return res.status(503).json({error:'livekit_not_configured'});const token=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:req.userId!,ttl:'15m'});token.addGrant({roomJoin:true,room,canPublish:true,canSubscribe:true,canPublishData:true});res.json({serverUrl:process.env.LIVEKIT_URL,room,token:await token.toJwt(),audioOnly:true});}));

app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{if(err instanceof z.ZodError)return res.status(400).json({error:'invalid_request',details:err.issues});console.error(err);res.status(500).json({error:'internal_error'});});
const port=Number(process.env.PORT)||4000;app.listen(port,()=>console.log(`KRMEET API listening on ${port}`));
