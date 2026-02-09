from src.tools.service_tools import get_services, get_service_info
from src.tools.center_tools import get_center_info
from src.tools.operator_tools import request_human_operator
from src.tools.availability_tools import check_availability
from src.tools.appointment_tools import (
    book_appointment,
    get_my_appointments,
    modify_appointment,
    cancel_appointment,
)

ALL_TOOLS = [
    get_services,
    get_service_info,
    get_center_info,
    request_human_operator,
    check_availability,
    book_appointment,
    get_my_appointments,
    modify_appointment,
    cancel_appointment,
]
