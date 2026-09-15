package jobs

import "sync"

type Event struct {
	Type    string `json:"type"`
	JobID   string `json:"job_id"`
	Payload any    `json:"payload,omitempty"`
}

type Bus struct {
	mu   sync.Mutex
	subs []chan Event
}

func NewBus() *Bus { return &Bus{} }

func (b *Bus) Sub(buf int) chan Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan Event, buf)
	b.subs = append(b.subs, ch)
	return ch
}

func (b *Bus) Unsub(ch chan Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, s := range b.subs {
		if s == ch {
			b.subs = append(b.subs[:i], b.subs[i+1:]...)
			close(ch)
			return
		}
	}
}

func (b *Bus) Pub(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, s := range b.subs {
		select {
		case s <- e:
		default:
		}
	}
}
