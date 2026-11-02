package sai

import (
	"context"
	"io"
	"time"
)

// FilesService uploads files to attach to a message.
type FilesService struct{ t *transport }

// Upload uploads one file (max 25 MB) to attach to a message. name is the file's name; the
// server derives the MIME type from it.
func (s *FilesService) Upload(ctx context.Context, name string, data io.Reader) (*Attachment, error) {
	body, err := io.ReadAll(data)
	if err != nil {
		return nil, err
	}
	if body == nil {
		body = []byte{}
	}
	d, err := s.t.json(ctx, "POST", "/v1/agents/upload", &request{
		body: body,
		// The server reads only a body that has a Content-Type; it derives the MIME type from the name.
		headers: map[string]string{"Content-Type": "application/octet-stream", "x-filename": esc(name)},
		timeout: 120 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	return parseAttachment(obj(d)), nil
}
