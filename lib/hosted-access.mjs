import {randomBytes, timingSafeEqual} from 'node:crypto';

export const webOrigin='https://switchboard-pilot.qsbyrzwycn.chatgpt.site';
const randomKey=()=>randomBytes(32).toString('hex');
const validKey=(expected,given)=>typeof given==='string'&&/^[a-f0-9]{64}$/.test(given)&&
  timingSafeEqual(Buffer.from(given,'hex'),Buffer.from(expected,'hex'));

export function hostedAccess(enabled,{now=Date.now}={}){
  let ticket,session;
  return {
    enabled,
    accepts(origin){return enabled&&origin===webOrigin;},
    link(){
      const key=randomKey();
      ticket={key,until:now()+5*60_000};
      return webOrigin+'/app/#pair='+key;
    },
    redeem(key){
      if(!ticket||ticket.until<=now()||!validKey(ticket.key,key))return null;
      ticket=undefined;
      session={key:randomKey(),until:now()+12*60*60_000};
      return session.key;
    },
    authorized(key){return !!session&&session.until>now()&&validKey(session.key,key);},
    disconnect(){ticket=undefined;session=undefined;},
  };
}

// The site can use the paired workspace, but local enrollment, live event
// streams, OS automation and provider credential entry use the local UI.
export function hostedRoute(route,method){
  if(method==='GET')return ['/api/bootstrap','/api/discover'].includes(route);
  if(method!=='POST')return false;
  if(['/api/web/pair','/api/web/disconnect','/api/connections/refresh','/api/import','/api/ideas','/api/ideas/start','/api/usage','/api/chats','/api/demo','/api/demo/clear'].includes(route))return true;
  return /^\/api\/chats\/[^/]+\/(send|update|park|stop|reset-session|pause-watch|resume-watch|analyze|reveal-file)$/.test(route);
}
