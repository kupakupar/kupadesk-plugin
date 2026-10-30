(() => {
  const status=document.getElementById('status'),retry=document.getElementById('retry');
  retry.hidden=false;
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
      // Web-mode fallback only. Native startup uses the prepared HTML hop.
      const value=await readConnection(),url=value?.url;
      if(value?.format!==1||value.entry!==36||typeof url!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/kupa-activate\/[a-f0-9]{64}\/view$/.test(url)||Number(new URL(url).port)>65535)throw Error('invalid');
      if(stopped)return;location.replace(url);stopped=true;
    }catch{
      attempts++;status.textContent=attempts<5?'本机页面正在准备，完成后会自动打开。':'本机页面服务尚未就绪，正在继续重试。';
    }finally{
      busy=false;clearTimeout(timer);if(!stopped)timer=setTimeout(connect,1500);
    }
  }
  retry.addEventListener('click',()=>{clearTimeout(timer);void connect();});
  addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);cancelLoad?.();});
  void connect();
})();
