# API Documentation: `/verifyNumber`

The `/verifyNumber` endpoint is used to authenticate users via their WhatsApp phone number. It checks if the phone number is enrolled in a tour and determines the user's access status based on the current date and the tour's dates.

---

## Endpoint Details

- **Path**: `POST /verifyNumber`
- **Content-Type**: `application/json`
- **url**: `https://tours-ai-api-anffe0brajezcndk.centralus-01.azurewebsites.net/verifyNumber`

### Request Body

| Field   | Type     | Description                                                                                                        |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `phone` | `string` | The user's phone number (e.g., `+919746672218` or `919746672218`). The system automatically strips `+` and spaces. |

**Example**:

```json
{
  "phone": "919746672218"
}
```

---

## Response Structure

The response returns full user and tour details, along with a computed `tour_status`.

| Field           | Type      | Description                                         |
| --------------- | --------- | --------------------------------------------------- |
| `exists`        | `boolean` | `true` if the user is found in the database.        |
| `phone`         | `string`  | The normalized phone number.                        |
| `name`          | `string`  | User's name.                                        |
| `tour_name`     | `string`  | Name of the assigned tour.                          |
| `itinerary_id`  | `string`  | The ID to be used for querying `/azure_ai_search`.  |
| `tour_status`   | `string`  | One of `upcoming`, `active`, `grace`, or `expired`. |
| `tour_end_date` | `string`  | The YYYY-MM-DD end date of the tour.                |

---

## Tour Status Logic

The `tour_status` is computed on-the-fly based on the current date:

1.  **Upcoming**: The tour has not started yet.
2.  **Active**: The tour is currently in progress.
3.  **Grace**: The tour ended, but the user is within the **5-day grace period**.
4.  **Expired**: The tour ended more than 5 days ago. **Access is hard-blocked.**

---

## HTTP Status Codes

The status code tells your webhook how to handle the message:

| Code              | Status                        | Meaning                                   |
| ----------------- | ----------------------------- | ----------------------------------------- |
| **200 OK**        | `active`, `upcoming`, `grace` | Proceed normally. Provide information.    |
| **403 Forbidden** | `expired`                     | User is known but their access has ended. |
| **404 Not Found** | `None` (Not in DB)            | The user is not registered for any tour.  |

## Sample Response

{
"exists": true,
"phone": "447501919228",
"name": "Rahul",
"email": "rahul@example.com",
"tour_id": "tour_QWW_2026_03",
"itinerary_id": "QWW_2026_03",
"tour_name": "Quebec's Winter Wonderland",
"tour_start_date": "2026-04-01",
"tour_end_date": "2026-04-25",
"tour_status": "active",
"status": "active",
"enrolled_at": "2026-04-13T16:02:45.097823Z"
}
