-- ================================================================
-- Atomic Appointment Booking Functions
-- Prevents race conditions with row-level locking (SELECT FOR UPDATE)
--
-- HOW TO APPLY:
-- 1. Open Supabase Dashboard > SQL Editor
-- 2. Paste this entire file and run it
-- 3. Verify in Database > Functions that both functions exist
-- ================================================================

-- Function: book_appointment_atomic
-- Atomically checks for time conflicts and inserts the appointment.
-- Uses SELECT FOR UPDATE to lock overlapping rows during the check.
CREATE OR REPLACE FUNCTION book_appointment_atomic(
    p_tenant_id UUID,
    p_client_id UUID,
    p_service_id UUID,
    p_staff_id UUID,
    p_start_at TIMESTAMPTZ,
    p_end_at TIMESTAMPTZ,
    p_source TEXT DEFAULT 'whatsapp',
    p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(
    success BOOLEAN,
    appointment_id UUID,
    error_message TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_conflict_count INTEGER;
    v_new_id UUID;
BEGIN
    -- Lock any overlapping appointments for this staff member
    PERFORM 1
    FROM appointments
    WHERE staff_id = p_staff_id
      AND tenant_id = p_tenant_id
      AND status IN ('pending', 'confirmed', 'in_service')
      AND start_at < p_end_at
      AND end_at > p_start_at
    FOR UPDATE;

    -- Count conflicts (after lock acquired)
    SELECT COUNT(*) INTO v_conflict_count
    FROM appointments
    WHERE staff_id = p_staff_id
      AND tenant_id = p_tenant_id
      AND status IN ('pending', 'confirmed', 'in_service')
      AND start_at < p_end_at
      AND end_at > p_start_at;

    IF v_conflict_count > 0 THEN
        RETURN QUERY SELECT
            FALSE,
            NULL::UUID,
            'Lo slot selezionato non è più disponibile. Per favore verifica la disponibilità aggiornata.'::TEXT;
        RETURN;
    END IF;

    -- No conflict: insert
    INSERT INTO appointments (
        tenant_id, client_id, service_id, staff_id,
        start_at, end_at, status, source, notes
    ) VALUES (
        p_tenant_id, p_client_id, p_service_id, p_staff_id,
        p_start_at, p_end_at, 'confirmed', p_source,
        COALESCE(p_notes, 'Prenotato via WhatsApp Bot')
    )
    RETURNING id INTO v_new_id;

    RETURN QUERY SELECT TRUE, v_new_id, NULL::TEXT;
END;
$$;


-- Function: modify_appointment_atomic
-- Atomically verifies ownership, checks conflicts, and reschedules.
CREATE OR REPLACE FUNCTION modify_appointment_atomic(
    p_appointment_id UUID,
    p_client_id UUID,
    p_tenant_id UUID,
    p_new_start_at TIMESTAMPTZ,
    p_new_end_at TIMESTAMPTZ
)
RETURNS TABLE(
    success BOOLEAN,
    error_message TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_staff_id UUID;
    v_status TEXT;
    v_old_notes TEXT;
    v_conflict_count INTEGER;
BEGIN
    -- Lock and verify ownership
    SELECT staff_id, status, notes
    INTO v_staff_id, v_status, v_old_notes
    FROM appointments
    WHERE id = p_appointment_id
      AND client_id = p_client_id
      AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Appuntamento non trovato o non appartiene a te.'::TEXT;
        RETURN;
    END IF;

    IF v_status NOT IN ('pending', 'confirmed') THEN
        RETURN QUERY SELECT FALSE, ('Impossibile modificare un appuntamento con stato: ' || v_status)::TEXT;
        RETURN;
    END IF;

    -- Lock other appointments for this staff at the new time
    PERFORM 1
    FROM appointments
    WHERE staff_id = v_staff_id
      AND tenant_id = p_tenant_id
      AND id != p_appointment_id
      AND status IN ('pending', 'confirmed', 'in_service')
      AND start_at < p_new_end_at
      AND end_at > p_new_start_at
    FOR UPDATE;

    -- Check for conflicts
    SELECT COUNT(*) INTO v_conflict_count
    FROM appointments
    WHERE staff_id = v_staff_id
      AND tenant_id = p_tenant_id
      AND id != p_appointment_id
      AND status IN ('pending', 'confirmed', 'in_service')
      AND start_at < p_new_end_at
      AND end_at > p_new_start_at;

    IF v_conflict_count > 0 THEN
        RETURN QUERY SELECT FALSE, 'Il nuovo orario non è disponibile.'::TEXT;
        RETURN;
    END IF;

    -- Update
    UPDATE appointments
    SET start_at = p_new_start_at,
        end_at = p_new_end_at,
        status = 'confirmed',
        notes = COALESCE(v_old_notes, '') || E'\nSpostato via WhatsApp il ' ||
                TO_CHAR(NOW() AT TIME ZONE 'Europe/Rome', 'DD/MM/YYYY HH24:MI'),
        updated_at = NOW()
    WHERE id = p_appointment_id;

    RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;
