# frozen_string_literal: true

require_relative "lib/sai/version"

Gem::Specification.new do |spec|
  spec.name = "sai-sdk"
  spec.version = Sai::VERSION
  spec.authors = ["Simular, Inc."]
  spec.summary = "Ruby SDK for the Sai API"
  spec.description = "Hand desktop work to Sai on a computer and get the answer back, or drive a cloud computer yourself."
  spec.homepage = "https://platform.simular.ai/documentation"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.1"
  spec.metadata = {
    "source_code_uri" => "https://github.com/simular-ai/sai-sdk/tree/main/ruby",
    "documentation_uri" => "https://platform.simular.ai/documentation/sdks/ruby",
    "rubygems_mfa_required" => "true"
  }
  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]
end
