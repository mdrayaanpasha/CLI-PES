package cfg

import (
	"expvar"
	"flag"
)

var port = flag.String("port", "9090", "config port")

func init() {
	expvar.Publish("uptime", expvar.Func(func() interface{} { return 0 }))
}
