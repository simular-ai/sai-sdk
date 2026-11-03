# frozen_string_literal: true

require_relative "test_helper"

# Parity with surface.json, the contract every language's SDK implements (AGENTS.md).
class SurfaceTest < Minitest::Test
  SURFACE = JSON.parse(File.read(File.join(ROOT, "surface.json")))
  # Attribute readers, which surface.json does not list.
  ATTRIBUTES = {
    Sai::Session => %i[id id= machine_id machine_id=],
    Sai::Turn => %i[id queued session status result],
    Sai::ControlLease => %i[machine_id idle_timeout_sec]
  }.freeze

  def public_methods_of(cls)
    (cls.public_instance_methods(false) - %i[inspect] - ATTRIBUTES.fetch(cls, [])).map(&:to_s).sort
  end

  def client
    @client ||= Sai::Client.new(api_key: "sapi_test")
  end

  def test_client_resources
    assert_equal SURFACE["resources"]["client"].sort, public_methods_of(Sai::Client)
  end

  SURFACE["resources"].each_key do |resource|
    next if resource == "client"

    define_method("test_resource_#{resource}") do
      assert_equal SURFACE["resources"][resource].sort, public_methods_of(client.public_send(resource).class)
    end
  end

  { "Session" => Sai::Session, "Turn" => Sai::Turn, "ControlLease" => Sai::ControlLease }.each do |name, cls|
    define_method("test_object_#{name}") do
      assert_equal SURFACE["objects"][name].sort, public_methods_of(cls)
    end
  end

  def test_errors
    exported = Sai.constants.map { |c| Sai.const_get(c) }
                  .select { |c| c.is_a?(Class) && c <= Sai::Error }
                  .map { |c| c == Sai::Error ? "SaiError" : c.name.delete_prefix("Sai::") }
    assert_equal SURFACE["errors"].sort, exported.sort
  end

  def test_error_hierarchy
    assert_operator Sai::LinkOnlyApprovalError, :<, Sai::ConflictError
    assert_operator Sai::SpendCapReachedError, :<, Sai::PermissionDeniedError
  end

  def test_event_kinds
    assert_equal SURFACE["event_kinds"], Sai::EVENT_KINDS
    assert_equal SURFACE["event_kinds"].sort, (Sai::Parse::KINDS.values | ["other"]).sort
  end

  def test_turn_statuses
    assert_equal SURFACE["turn_statuses"], Sai::TURN_STATUSES
    assert_equal SURFACE["turn_record_statuses"], Sai::TURN_RECORD_STATUSES
  end
end
