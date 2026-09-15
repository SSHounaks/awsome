package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"awsome/internal/collect"
	"awsome/internal/config"
	"awsome/internal/jobs"
)

type Server struct {
	addr    string
	manager *jobs.Manager
	cfg     config.Config
}

func New(addr string, cfg config.Config, m *jobs.Manager) *Server {
	return &Server{addr: addr, manager: m, cfg: cfg}
}

func (s *Server) ListenAndServe(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: s.routes()}
	go func() {
		<-ctx.Done()
		shut, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		_ = srv.Shutdown(shut)
	}()
	log.Printf("control: listening on http://%s", s.addr)
	return srv.Serve(ln)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /jobs", s.handleCreate)
	mux.HandleFunc("GET /jobs", s.handleList)
	mux.HandleFunc("GET /jobs/{id}", s.handleGet)
	mux.HandleFunc("POST /jobs/{id}/cancel", s.handleCancel)
	mux.HandleFunc("POST /jobs/{id}/resume", s.handleResume)
	mux.HandleFunc("GET /jobs/{id}/events", s.handleEvents)
	return mux
}

type createRequest struct {
	Regions []string `json:"regions,omitempty"`
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	regions := req.Regions
	cfg := s.cfg
	if len(regions) > 0 {
		cfg.Regions = join(regions)
	}
	tctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	target, err := collect.ResolveTarget(tctx, cfg)
	if err != nil {
		writeErr(w, http.StatusBadGateway, fmt.Errorf("resolve target: %w", err))
		return
	}
	job, err := s.manager.Enqueue(jobs.CfgFrom(s.cfg), target, target.Regions)
	if err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.manager.List())
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	job, ok := s.manager.Get(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusNotFound, errors.New("job not found"))
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if err := s.manager.Cancel(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	job, _ := s.manager.Get(r.PathValue("id"))
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleResume(w http.ResponseWriter, r *http.Request) {
	if err := s.manager.Resume(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	job, _ := s.manager.Get(r.PathValue("id"))
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.manager.Get(id); !ok {
		writeErr(w, http.StatusNotFound, errors.New("job not found"))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, errors.New("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	if job, _ := s.manager.Get(id); job != nil {
		emitEvent(w, jobs.Event{Type: "job.snapshot", JobID: id, Payload: job})
		flusher.Flush()
	}
	sub := s.manager.Bus().Sub(16)
	defer s.manager.Bus().Unsub(sub)
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-sub:
			if e.JobID == id {
				emitEvent(w, e)
				flusher.Flush()
			}
		case <-ticker.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func emitEvent(w http.ResponseWriter, e jobs.Event) {
	b, _ := json.Marshal(e)
	fmt.Fprintf(w, "data: %s\n\n", b)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func join(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ","
		}
		out += p
	}
	return out
}
