package probe

import (
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func Start() {
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {})
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM)
}
