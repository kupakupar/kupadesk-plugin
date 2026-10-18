// Native transport diagnostic only. Does not import or read Magpie configuration.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const pagePrefix = "/_magpie/plugin/0123456789abcdef0123456789abcdef/"

type windowSchemeKey struct{}

// Copied from official Magpie v0.1.1273 window_peer.go.
func ownWindow(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.RemoteAddr = "127.0.0.1:0"
		scheme := "wails"
		if runtime.GOOS == "windows" {
			scheme = "http"
		}
		r = r.WithContext(context.WithValue(r.Context(), windowSchemeKey{}, scheme))
		next.ServeHTTP(w, r)
	})
}

// Same directives and native scheme handling as official pluginpage.go.
func pagePolicy(r *http.Request) string {
	own := "'self'"
	if r.Host != "" {
		own = r.Host + pagePrefix
		if scheme, _ := r.Context().Value(windowSchemeKey{}).(string); scheme != "" {
			own = scheme + "://" + own
		}
	}
	return strings.Join([]string{
		"sandbox allow-scripts", "default-src 'none'", "script-src " + own,
		"style-src " + own + " 'unsafe-inline'", "img-src " + own + " data:",
		"font-src " + own, "media-src " + own, "connect-src 'none'", "frame-src 'none'",
		"worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
	}, "; ")
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	root := filepath.Dir(exe)
	pageDir := flag.String("page-dir", filepath.Join(root, "page"), "isolated snapshot of plugin page files")
	port := flag.Int("cdp-port", 4638, "loopback-only Chromium diagnostic port")
	visible := flag.Bool("visible", false, "show the isolated native test window")
	loopback := flag.String("loopback", "127.0.0.2", "isolated 127.0.0.2 or 127.0.0.3 transport")
	flag.Parse()
	if *port < 1024 || *port > 65535 {
		log.Fatal("invalid diagnostic port")
	}
	if *loopback != "127.0.0.2" && *loopback != "127.0.0.3" {
		log.Fatal("invalid fixture loopback")
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
	}
	ln.Close()
	pageRoot, err := filepath.Abs(*pageDir)
	if err != nil {
		log.Fatal(err)
	}
	profile := filepath.Join(root, "profile")
	if err = os.MkdirAll(profile, 0700); err != nil {
		log.Fatal(err)
	}
	logger, err := os.OpenFile(filepath.Join(root, "transport.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		log.Fatal(err)
	}
	defer logger.Close()
	log.SetOutput(logger)
	mux := http.NewServeMux()
	mux.HandleFunc(pagePrefix, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "method not allowed", 405)
			return
		}
		rel := strings.TrimPrefix(r.URL.Path, pagePrefix)
		log.Printf("asset method=%s host=%s path=%s dest=%s", r.Method, r.Host, rel, r.Header.Get("Sec-Fetch-Dest"))
		w.Header().Set("Content-Security-Policy", pagePolicy(r))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-cache")
		file := filepath.Join(pageRoot, filepath.FromSlash(rel))
		if !strings.HasPrefix(strings.ToLower(file), strings.ToLower(pageRoot+string(filepath.Separator))) {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(file)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			http.NotFound(w, r)
			return
		}
		if rel == "_magpie/bridge.js" {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		http.ServeContent(w, r, filepath.Base(file), st.ModTime(), f)
	})
	mux.HandleFunc("/host.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		fmt.Fprint(w, `let frame=document.querySelector('iframe'); const status=document.querySelector('#status');
const initial={schemaVersion:1,enabled:true,bindings:[{id:'a',name:'Fixture A',enabled:true,prompt:'STABILITY_TEST_A '.repeat(1200),models:['test/a']},{id:'b',name:'Fixture B',enabled:true,prompt:'STABILITY_TEST_B '.repeat(850),models:['test/b']}]};
const fixture=window.fixture={hello:0,reads:0,writes:0,errors:[],heartbeat:0,theme:{dark:true,lang:'zh-CN',tokens:{bg:'#252629',fg:'#ededed',muted:'#a1a1aa',line:'#393a40',accent:'#a6afff'}},options:initial};
setInterval(()=>fixture.heartbeat++,1000);
fixture.remount=()=>{const next=frame.cloneNode();frame.replaceWith(next);frame=next;};
fixture.toggleTheme=()=>{fixture.theme.dark=!fixture.theme.dark;frame.contentWindow.postMessage({magpie:1,event:'theme',data:fixture.theme},'*');};
addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.data?.magpie!==1)return; const m=e.data; status.textContent='received: '+m.method; let result;
if(m.method==='hello'){fixture.hello++;result=fixture.theme;}
else if(m.method==='options.get'){fixture.reads++;if(fixture.holdCount>0){fixture.holdCount--;fixture.held.push({source:e.source,id:m.id});return;}result=fixture.options;}
else if(m.method==='options.set'){fixture.writes++;fixture.options=m.params.options;result=fixture.options;}
else if(m.method==='read')result=[];
else if(m.method==='error'){fixture.errors.push(m.params?.message||'page error');return;}
else{frame.contentWindow.postMessage({magpie:1,id:m.id,error:'unknown fixture method'},'*');return;}
frame.contentWindow.postMessage({magpie:1,id:m.id,result},'*');});`)
	})
	mux.HandleFunc("/panel", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><title>Isolated background panel</title><script>setInterval(()=>{document.title='Isolated panel '+Date.now()},1000)</script>`)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><title>KupaDesk transport diagnostic</title><style>html,body{margin:0;height:100%%;background:#252629;color:#eee;font:14px sans-serif}#status{height:24px}iframe{width:100%%;height:calc(100%% - 24px);border:0}</style><script src="/host.js" defer></script></head><body><div id="status">Waiting for isolated plugin hello</div><iframe sandbox="allow-scripts" src="%sindex.html"></iframe></body></html>`, pagePrefix)
	})
	app := application.New(application.Options{
		Name: "KupaDesk isolated refresh test", Description: "Isolated WebView2 observation; no Magpie configuration access",
		Assets:       application.AssetOptions{Handler: ownWindow(mux)},
		Windows:      application.WindowsOptions{WebviewUserDataPath: profile, AdditionalBrowserArgs: []string{"--remote-debugging-address=127.0.0.1", fmt.Sprintf("--remote-debugging-port=%d", *port), fmt.Sprintf(`--host-resolver-rules="MAP wails.localhost %s"`, *loopback)}},
		ErrorHandler: func(err error) { log.Printf("wails: %v", err) },
	})
	app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "KupaDesk isolated background panel", Width: 400, Height: 500, URL: "/panel", Hidden: true})
	app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "KupaDesk isolated refresh test", Width: 1000, Height: 900, URL: "/", DevToolsEnabled: true, Hidden: !*visible})
	log.Printf("start time=%s page=%s cdp=127.0.0.1:%d", time.Now().Format(time.RFC3339), pageRoot, *port)
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
