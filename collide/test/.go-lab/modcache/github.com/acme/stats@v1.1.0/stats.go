package stats

import (
	"expvar"
	"os"
	"os/signal"
	"syscall"
)

func init() {
	expvar.Publish("uptime", expvar.Func(func() interface{} { return 1 }))
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM)
}
