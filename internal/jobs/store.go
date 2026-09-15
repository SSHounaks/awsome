package jobs

import (
	"encoding/json"
	"time"

	bolt "go.etcd.io/bbolt"
)

type Store struct{ db *bolt.DB }

func OpenStore(path string) (*Store, error) {
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, err
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists([]byte("jobs"))
		return err
	}); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Save(j *Job) error {
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("jobs")).Put([]byte(j.ID), b)
	})
}

func (s *Store) All() []*Job {
	var out []*Job
	_ = s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("jobs")).ForEach(func(_, v []byte) error {
			var j Job
			if err := json.Unmarshal(v, &j); err == nil {
				out = append(out, &j)
			}
			return nil
		})
	})
	return out
}

func (s *Store) Close() error { return s.db.Close() }
