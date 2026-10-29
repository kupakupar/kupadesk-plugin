(() => {
  const status=document.getElementById('status'),retry=document.getElementById('retry');
  let timer,busy=false,stopped=false,attempts=0,script,cancelLoad;
  parent.postMessage({magpie:1,id:'kupa-entry-ready',method:'hello'},'*');
  function readConnection(){
    return new Promise((resolve,reject)=>{
      window.KUPADESK_CONNECTION=undefined;script=document.createElement('script');
      let complete=false;const finish=error=>{if(complete)return;complete=true;clearTimeout(deadline);script?.remove();script=null;cancelLoad=null;error?reject(error):resolve(window.KUPADESK_CONNECTION);};
      const deadline=setTimeout(()=>finish(Error('waiting')),3000);cancelLoad=()=>finish(Error('closed'));
      script.onload=()=>finish();script.onerror=()=>finish(Error('preparing'));
      script.src=new URL('connection.js?check='+Date.now(),location.href).href;document.head.append(script);
    });
  }
  async function connect(){
    if(stopped||busy)return;busy=true;
    try{
      // Magpie 1883 forbids fetch but permits this page's own scripts.
      const value=await readConnection(),url=value?.url;
      if(value?.format!==1||value.entry!==35||typeof url!=='string'||!/^http:\/\/127\.0\.0\.1:\d{1,5}\/kupa-activate\/[a-f0-9]{64}\/view$/.test(url)||Number(new URL(url).port)<1||Number(new URL(url).port)>65535)throw Error('invalid');
      if(stopped)return;location.replace(url);stopped=true;
    }catch{
      attempts++;status.textContent=attempts<5?'\u672C\u673A\u9875\u9762\u6B63\u5728\u51C6\u5907\uFF0C\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u6253\u5F00\u3002':'\u672C\u673A\u9875\u9762\u670D\u52A1\u5C1A\u672A\u5C31\u7EEA\uFF0C\u6B63\u5728\u7EE7\u7EED\u91CD\u8BD5\u3002';
    }finally{
      busy=false;clearTimeout(timer);if(!stopped)timer=setTimeout(connect,1500);
    }
  }
  retry.addEventListener('click',()=>{clearTimeout(timer);void connect();});
  addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);cancelLoad?.();});
  void connect();
})();
