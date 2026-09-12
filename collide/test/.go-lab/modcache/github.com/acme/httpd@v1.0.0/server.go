package httpd

import (
	"flag"
	"net/http"
)

var port = flag.String("port", "8080", "listen port")

func init() {
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {})
}
