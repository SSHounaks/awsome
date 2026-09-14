package collect

import "sync"

type Emitter struct {
	mu  sync.Mutex
	ch  chan any
	one sync.Once
}

func NewEmitter(buf int) *Emitter {
	return &Emitter{ch: make(chan any, buf)}
}

func (e *Emitter) Send(r any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ch <- r
}

func (e *Emitter) Close() {
	e.one.Do(func() { close(e.ch) })
}

func (e *Emitter) Chan() <-chan any { return e.ch }
