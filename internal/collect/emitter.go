package collect

import (
	"sync"
	"sync/atomic"

	"awsome/internal/model"
)

type Emitter struct {
	ch    chan any
	one   sync.Once
	nodes atomic.Int64
	edges atomic.Int64
}

func NewEmitter(buf int) *Emitter {
	return &Emitter{ch: make(chan any, buf)}
}

func (e *Emitter) Send(r any) {
	switch r.(type) {
	case model.Node:
		e.nodes.Add(1)
	case model.Edge:
		e.edges.Add(1)
	}
	e.ch <- r
}

func (e *Emitter) Counts() (nodes, edges int64) {
	return e.nodes.Load(), e.edges.Load()
}

func (e *Emitter) Close() {
	e.one.Do(func() { close(e.ch) })
}

func (e *Emitter) Chan() <-chan any { return e.ch }
