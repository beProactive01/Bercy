// Workspace storage in SQLite. Each workflow is one row, so a save writes only the workflows that changed;
// workspace-level settings live in `meta`; execution events append to `events` as an audit trail.
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');

class Store{
  constructor(file){
    this.file=file;this.db=new DatabaseSync(file);
    this.db.exec(`pragma journal_mode=wal;pragma synchronous=normal;
      create table if not exists meta(key text primary key,json text not null);
      create table if not exists sessions(id text primary key,json text not null,updated integer not null);
      create table if not exists events(seq integer primary key autoincrement,at integer not null,session text,node text,kind text not null,json text not null);
      create index if not exists events_session on events(session,seq);`);
    if(this.db.prepare('pragma quick_check').get().quick_check!=='ok')throw Error('数据库校验未通过');
  }
  // Opens the store; an unreadable database is moved aside and replaced by an empty one.
  static open(file){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    try{return {store:new Store(file)}}catch(err){
      const backup=file.replace(/\.db$/,'.corrupt-'+Date.now()+'.db');
      for(const ext of ['','-wal','-shm'])try{fs.renameSync(file+ext,backup+ext)}catch{}
      return {store:new Store(file),problem:{storageError:err.message,backup}};
    }
  }
  directory(sessionId){
    const row=this.db.prepare("select json_extract(json,'$.directory') as directory from sessions where id=?").get(String(sessionId));
    return row?.directory||null;
  }
  empty(){return !this.db.prepare('select 1 from sessions limit 1').get()&&!this.db.prepare('select 1 from meta limit 1').get()}
  load(){
    if(this.empty())return null;
    const meta=Object.fromEntries(this.db.prepare('select key,json from meta').all().map(r=>[r.key,JSON.parse(r.json)]));
    const rows=new Map(this.db.prepare('select id,json from sessions').all().map(r=>[r.id,r.json]));
    const order=Array.isArray(meta.sessionOrder)?meta.sessionOrder:[];delete meta.sessionOrder;
    const ids=[...order.filter(id=>rows.has(id)),...[...rows.keys()].filter(id=>!order.includes(id))];
    return {...meta,sessions:ids.map(id=>JSON.parse(rows.get(id)))};
  }
  // patch: {meta?: JSON string of workspace fields, upsert?: [{id, json}], remove?: [id]} — applied atomically.
  apply(patch){
    const now=Date.now(),put=this.db.prepare('insert into sessions(id,json,updated) values(?,?,?) on conflict(id) do update set json=excluded.json,updated=excluded.updated');
    const drop=this.db.prepare('delete from sessions where id=?'),meta=this.db.prepare('insert into meta(key,json) values(?,?) on conflict(key) do update set json=excluded.json');
    this.db.exec('begin');
    try{
      for(const s of patch.upsert||[]){if(typeof s?.id!=='string'||typeof s.json!=='string')throw Error('无效的工作流记录');JSON.parse(s.json);put.run(s.id,s.json,now)}
      for(const id of patch.remove||[])if(typeof id==='string')drop.run(id);
      if(typeof patch.meta==='string')for(const [k,v] of Object.entries(JSON.parse(patch.meta)))meta.run(k,JSON.stringify(v));
      this.db.exec('commit');
    }catch(err){this.db.exec('rollback');throw err}
    return true;
  }
  // One-time import of the JSON workspace used by earlier versions.
  importWorkspace(data){
    const {sessions=[],...rest}=data||{};
    return this.apply({meta:JSON.stringify({...rest,sessionOrder:sessions.map(s=>s.id)}),upsert:sessions.map(s=>({id:s.id,json:JSON.stringify(s)}))});
  }
  log(session,node,kind,payload){
    this.db.prepare('insert into events(at,session,node,kind,json) values(?,?,?,?,?)').run(Date.now(),session||null,node||null,kind,JSON.stringify(payload??null));
    if(++this.logged%500===0)this.db.prepare('delete from events where seq<=(select max(seq)-50000 from events)').run();
  }
  events(session,limit=200){return this.db.prepare('select at,node,kind,json from events where session=? order by seq desc limit ?').all(session,limit).map(r=>({...r,json:JSON.parse(r.json)}))}
  backup(dest){try{fs.rmSync(dest,{force:true});this.db.exec(`vacuum into '${dest.replace(/'/g,"''")}'`)}catch{}}
  close(){try{this.db.close()}catch{}}
}
Store.prototype.logged=0;
module.exports={Store};
