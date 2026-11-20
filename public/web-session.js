export const companionUrl='http://127.0.0.1:4317';
const sessionKey='switchboard-web-session';
const isKey=key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key);

export function webRequest(route,{session='',data}={}){
  // Relative API paths only. A redirect cannot forward the pairing credential.
  if(!route.startsWith('/api/'))throw Error('Invalid Switchboard route.');
  return fetch(companionUrl+route,{
    method:data===undefined?'GET':'POST',
    headers:{...(session?{'X-Switchboard-Web-Session':session}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},
    body:data===undefined?undefined:JSON.stringify(data),
    credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),
  });
}

export function clearWebSession(){sessionStorage.removeItem(sessionKey);}

export async function enterWebWorkspace(app){
  const origin=document.documentElement.dataset.webOrigin;
  if(location.origin!==origin||!isSecureContext||window.top!==window){
    app.textContent='Open the secure Switchboard website directly to connect this Mac.';
    return null;
  }
  const fragment=new URLSearchParams(location.hash.slice(1));
  const ticket=fragment.get('pair');
  if(fragment.has('pair'))history.replaceState(null,'',location.pathname);
  let session=sessionStorage.getItem(sessionKey);
  app.innerHTML='<main class="idea-workspace"><h1>Switchboard</h1><p>Connect to Switchboard on this Mac to use its Codex and Claude Code sessions.</p><button class="primary-button" id="connect-mac">Connect to this Mac</button><p role="status" id="connect-status"></p><p class="idea-intro"><a id="local-switchboard" href="http://127.0.0.1:4317/">Open Switchboard on this Mac</a> and choose Options → Open on website for a fresh link.</p></main>';
  const button=app.querySelector('#connect-mac'),status=app.querySelector('#connect-status');
  if(!isKey(ticket)&&!isKey(session)){
    button.hidden=true;
    return null;
  }
  return new Promise(resolve=>{
    button.onclick=async()=>{
      button.disabled=true;
      status.textContent='Connecting…';
      try{
        if(isKey(ticket)&&!session){
          const paired=await webRequest('/api/web/pair',{data:{pair:ticket}});
          if(!paired.ok)throw Error('Open a new pairing link from Switchboard on this Mac.');
          session=(await paired.json()).session;
          if(!isKey(session))throw Error('Switchboard returned an invalid session.');
          sessionStorage.setItem(sessionKey,session);
        }
        const boot=await webRequest('/api/bootstrap',{session});
        if(!boot.ok){
          clearWebSession();
          throw Error('This session ended. Open a new pairing link from Switchboard on this Mac.');
        }
        resolve({session,state:await boot.json()});
      }catch(error){
        status.textContent=error.name==='TypeError'||error.name==='TimeoutError'
          ? 'Keep Switchboard running on this Mac and allow the browser’s request to connect to this device.'
          : error.message;
        button.disabled=false;
      }
    };
    if(isKey(ticket)){session=null;clearWebSession();}
  });
}

export function webUpdates(session){
  let stopped=false,timer,last;
  const stream={close(){stopped=true;clearTimeout(timer);},onmessage:null,onerror:null};
  async function poll(){
    try{
      const response=await webRequest('/api/bootstrap',{session});
      if(response.status===401){clearWebSession();stream.close();stream.onerror?.({expired:true});return;}
      if(!response.ok)throw Error('Switchboard is unavailable.');
      const data=await response.text();
      if(!stopped&&data!==last){last=data;stream.onmessage?.({data});}
    }catch{last=undefined;if(!stopped)stream.onerror?.();}
    finally{if(!stopped)timer=setTimeout(poll,1800);}
  }
  timer=setTimeout(poll,0);
  return stream;
}
