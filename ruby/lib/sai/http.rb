# frozen_string_literal: true

require "json"
require "net/http"
require "openssl"
require "uri"

module Sai
  DEFAULT_BASE_URL = "https://api.simular.ai"

  # @api private
  # The one place requests are made: auth header, error mapping, timeouts.
  class Http
    Response = Struct.new(:status, :reason, :body, :headers, keyword_init: true)

    # +credential+ is the bearer token, or a callable that returns it before each request.
    def initialize(credential, base_url, timeout, version_tag)
      @credential = credential
      @base_url = base_url.sub(%r{/+\z}, "")
      @timeout = timeout
      @headers = { "User-Agent" => "sai-ruby/#{VERSION}" }
      @headers["Authorization"] = "Bearer #{credential}" unless credential.respond_to?(:call)
      # routes the request to a tagged API revision
      @headers["x-sai-version"] = version_tag if version_tag && !version_tag.empty?
    end

    def request(method, path, json: UNSET, params: nil, body: nil, headers: nil, timeout: nil)
      uri = URI(@base_url + path)
      query = (params || {}).reject { |_, v| v.nil? }
      uri.query = URI.encode_www_form(query.map { |k, v| [k.to_s, v.to_s] }) unless query.empty?
      req = Net::HTTPGenericRequest.new(
        method, !body.nil? || !json.equal?(UNSET), true, uri.request_uri
      )
      @headers.merge(headers || {}).each { |k, v| req[k] = v }
      req["Authorization"] = "Bearer #{@credential.call}" if @credential.respond_to?(:call)
      if !json.equal?(UNSET)
        req["Content-Type"] = "application/json"
        req.body = JSON.generate(json)
      elsif body
        req.body = body
      end
      res = perform(uri, req, timeout || @timeout)
      raise to_error(res) if res.status >= 400

      res
    end

    def json(method, path, **opts)
      res = request(method, path, **opts)
      text = res.body.to_s.dup.force_encoding(Encoding::UTF_8)
      text.empty? ? nil : JSON.parse(text)
    end

    UNSET = Object.new.freeze

    private

    def perform(uri, req, timeout)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = timeout
      http.read_timeout = timeout
      http.write_timeout = timeout
      res = http.start { http.request(req) }
      headers = {}
      res.each_header { |k, v| headers[k] = v }
      Response.new(status: res.code.to_i, reason: res.message.to_s, body: (res.body || "").b, headers: headers)
    rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise ConnectionError, "Request to #{host(uri)} timed out."
    rescue SocketError, SystemCallError, IOError, OpenSSL::SSL::SSLError => e
      raise ConnectionError,
            "Could not reach the Sai API at #{host(uri)}: #{e.message}. Check the network and SAI_API_URL."
    end

    def host(uri)
      uri.port == uri.default_port ? uri.host : "#{uri.host}:#{uri.port}"
    end

    def to_error(res)
      text = res.body.dup.force_encoding(Encoding::UTF_8)
      body = begin
        parsed = JSON.parse(text)
        if parsed.is_a?(Hash) then parsed
        elsif parsed.is_a?(Array) then { "error" => parsed.join(",") }
        else { "error" => parsed.nil? ? "null" : parsed.to_s }
        end
      rescue JSON::ParserError
        short = text[0, 500]
        { "error" => short.nil? || short.empty? ? res.reason : short }
      end
      Errors.for(res.status, body, retry_after(res.headers["retry-after"]))
    end

    def retry_after(raw)
      return nil if raw.nil? || raw.strip.empty?

      v = Float(raw)
      v == v.floor ? v.to_i : v
    rescue ArgumentError
      nil
    end
  end
end
